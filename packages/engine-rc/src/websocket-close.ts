// On Node 22, a WebSocket whose connection is refused fires `error` and never
// `close`, even after close(), and stays CLOSING for good; Node 24 fires an
// unclean `close` straight after. polkadot-js's WsProvider, which wallet SDK
// 2.0 opens to ask the node for its finalized head while a wallet syncs,
// clears its handler-timeout interval only on `close`, so against a node that
// refuses the connection that interval keeps a program's process up after its
// wallet has stopped.
//
// Node 22's global WebSocket is replaced here, before polkadot-js reads it as
// it loads, by one that fires the `close` Node 24 fires: when a connection
// fails before it opened and no `close` follows, an unclean `close` with code
// 1006, the code the WebSocket standard gives a connection that failed. A
// `close` from Node itself after that is dropped, so a listener hears one
// either way.

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
/** The code the WebSocket standard closes a failed connection with (abnormal closure). */
const ABNORMAL_CLOSURE = 1006;

function fireCloseOnFailedConnect(Native: typeof WebSocket): typeof WebSocket {
  return class WebSocketClosingOnFailedConnect extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      let closed = false;
      // Registered before any caller's listener, so a second `close` stops here.
      this.addEventListener('close', (event) => {
        if (closed) event.stopImmediatePropagation();
        closed = true;
      });
      this.addEventListener('error', () => {
        if (this.readyState === Native.OPEN) return;
        setTimeout(() => {
          if (closed) return;
          this.dispatchEvent(Object.assign(new Event('close'), { code: ABNORMAL_CLOSURE, reason: '', wasClean: false }));
        }, 0);
      });
    }
  };
}

if (NODE_MAJOR < 24 && typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = fireCloseOnFailedConnect(globalThis.WebSocket);
}
