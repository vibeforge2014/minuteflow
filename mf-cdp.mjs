const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find(p => p.type === 'page' && p.url.includes('5173')) || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const res = await send('Runtime.evaluate', { expression: process.argv[2], returnByValue: true, awaitPromise: true });
if (res.result?.exceptionDetails) console.error(JSON.stringify(res.result.exceptionDetails, null, 2));
else { const v = res.result?.result?.value; console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }
ws.close();
