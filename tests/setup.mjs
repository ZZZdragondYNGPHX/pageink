// Runtime modules use the browser's timer surface. Tests keep Node's real and mockable timers.
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
