const nonce = location.hash.slice(1), status = document.querySelector('#status');
const CHANNEL = 'cs2-native-local-v1';
if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('Invalid local render session');
let origin = null, job = null, sending = false;
const waiting = new Map();
const local = async (route, options = {}) => {
  const response = await fetch(route, { ...options, headers: { authorization: `Bearer ${nonce}`, ...(options.headers ?? {}) } });
  if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error ?? '本地渲染请求失败'); }
  return response;
};
const post = (type, detail = {}, transfer = []) => window.opener.postMessage({ channel: CHANNEL, nonce, type, ...detail }, origin, transfer);
function waitFor(type, key, timeout = 120000) {
  const id = `${type}:${key}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('网页上传连接超时，请保持 Dashboard 打开。')); }, timeout);
    waiting.set(id, message => { clearTimeout(timer); waiting.delete(id); if (message.ok === true) resolve(message); else reject(new Error(message.error ?? '网页未接受原生回放')); });
  });
}
window.addEventListener('message', async event => {
  if (!origin || event.origin !== origin || event.source !== window.opener || event.data?.channel !== CHANNEL || event.data?.nonce !== nonce) return;
  const data = event.data;
  const key = data.type === 'artifact-ack' ? `${data.artifact_id}:${data.part_index}` : (data.job_id ?? job?.job_id ?? '');
  const waitingFor = waiting.get(`${data.type}:${key}`);
  if (waitingFor) { waitingFor(data); return; }
  if (data.type !== 'job' || (job && sending)) return;
  try {
    await local('/job', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data.job) });
    job = data.job; sending = false;
    post('job-accepted', { job_id: job.job_id });
  } catch (error) { post('error', { job_id: data.job?.job_id, error: error.message }); status.textContent = error.message; }
});

async function upload(receipt) {
  sending = true;
  const prepared = waitFor('prepared-ack', receipt.job_id);
  post('prepared', { job_id: receipt.job_id, receipt });
  await prepared;
  for (const clip of receipt.clips) for (const artifact of clip.artifacts) for (let part = 0; part < artifact.part_count; part++) {
    const body = await (await local(`/artifact?id=${encodeURIComponent(artifact.artifact_id)}&part=${part}`)).arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(x => x.toString(16).padStart(2, '0')).join('');
    const ack = waitFor('artifact-ack', `${artifact.artifact_id}:${part}`);
    post('artifact-part', { job_id: receipt.job_id, artifact_id: artifact.artifact_id, part_index: part, sha256, body }, [body]);
    await ack;
  }
  const completed = waitFor('complete-ack', receipt.job_id);
  post('complete', { job_id: receipt.job_id, receipt });
  await completed;
  await local('/done', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: receipt.job_id, uploaded: true }) });
  status.textContent = '原生回放已上传，可以返回 Dashboard 查看。';
  post('uploaded', { job_id: receipt.job_id });
  job = null; sending = false;
}

async function poll() {
  try {
    if (!window.opener || window.opener.closed) throw new Error('Dashboard 已关闭。请从 Dashboard 重新打开本地渲染。');
    const value = await (await local('/status')).json();
    origin = value.origin;
    if (!job && value.state === 'ready') post('ready', { version: value.version });
    if (value.message) status.textContent = value.message;
    if (job) post('status', { job_id: job.job_id, state: value.state, message: value.message });
    if (job && value.state === 'prepared' && !sending) await upload(value.receipt);
    if (value.state === 'failed' && job) { post('error', { job_id: job.job_id, error: value.message }); job = null; }
    setTimeout(poll, 1000);
  } catch (error) { status.textContent = error.message; if (origin && job) post('error', { job_id: job.job_id, error: error.message }); }
}
poll();
