import postcss from 'postcss';

// Keep upstream styles, variables and animation names inside our own editor.
export function isolateKernelCss(css) {
  const scope = ':is(.ink-editor,.ink-kernel-portal)';
  const root = postcss.parse(css);
  const names = new Map();
  root.walkAtRules(/keyframes$/, rule => {
    names.set(rule.params, `ink-kernel-${rule.params}`);
    rule.params = names.get(rule.params);
  });
  root.walkRules(rule => {
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && /keyframes$/.test(parent.name)) return;
    }
    rule.selector = postcss.list.comma(rule.selector).map(selector => {
      if (selector === ':root') return scope;
      const dir = selector.match(/^(:root\[dir=(?:ltr|rtl)\])\s+/);
      if (dir) return `${dir[1]} ${scope} ${selector.slice(dir[0].length)}`;
      return `${scope} ${selector}`;
    }).join(',');
  });
  root.walkDecls(decl => {
    if (/^(?:-webkit-)?animation(?:-name)?$/.test(decl.prop)) {
      decl.value = decl.value.replace(/[\w-]+/g, token => names.get(token) ?? token);
    }
    if (/^font(?:-family)?$/.test(decl.prop)) decl.value = decl.value.replace(/\bAssistant\b/g, 'InkKernelAssistant');
  });
  return root.toString();
}
