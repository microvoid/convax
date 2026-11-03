/** Verify production window capture in a Desktop already launched through its supported dsh profile. */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '9229' },
  artifacts: { type: 'string', default: '.artifacts/window-capture-native' },
  'keep-source': { type: 'boolean', default: false },
} })
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A loopback inspector port is required')
const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(response => response.json())
const target = targets.find(item => item.type === 'node' && typeof item.webSocketDebuggerUrl === 'string')
if (!target) throw new Error('Launch the supported development Desktop before running this fixture')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((accept, reject) => {
  socket.addEventListener('open', accept, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const result = JSON.parse(String(event.data))
  const waiter = pending.get(result.id)
  if (!waiter) return
  pending.delete(result.id)
  if (result.error) waiter.reject(new Error(result.error.message))
  else waiter.resolve(result.result)
})
const call = (method, params) => new Promise((accept, reject) => {
  const id = ++nextId
  pending.set(id, { resolve: accept, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

async function nativeFixture({ artifacts, keepSource }) {
  const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/__window_capture_fixture__.cjs`)
  const { BrowserWindow } = require('electron')
  const { randomUUID } = require('node:crypto')
  const { mkdirSync, writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('dsh-app://app/'))
  if (!owner) throw new Error('The supported primary application document is unavailable')
  const available = await owner.webContents.executeJavaScript('Boolean(window.dshDesktop?.windowCapture)')
  if (!available) throw new Error('The running Desktop does not contain the production window capture bridge')
  const nonce = `Convax capture fixture ${randomUUID()}`
  const stateKey = `__dshCaptureFixture_${randomUUID().replaceAll('-', '')}`
  const evidence = { sourceTitle: nonce }
  const evaluate = async (body) => {
    const result = await owner.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${body})()}}catch(error){return {ok:false,error:{name:error?.name??'Error',message:error?.message??String(error)}}}})()`, true)
    if (!result.ok) throw new Error(`${result.error.name}: ${result.error.message}`)
    return result.value
  }
  const waitFor = async (operation, subject) => {
    const deadline = Date.now() + 8000
    while (!await operation()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${subject}`)
      await new Promise(accept => setTimeout(accept, 100))
    }
  }
  const createSource = async (title) => {
    const window = new BrowserWindow({ width: 400, height: 300, show: false, title,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    try {
      await window.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font:20px sans-serif;color:white;text-align:center;background:#125"><i style="position:fixed;left:8px;top:8px;width:16px;height:16px;background:#f00"></i><i style="position:fixed;right:8px;top:8px;width:16px;height:16px;background:#0f0"></i><i style="position:fixed;left:8px;bottom:8px;width:16px;height:16px;background:#00f"></i><i style="position:fixed;right:8px;bottom:8px;width:16px;height:16px;background:#ff0"></i><p>Convax generated test window</p><div id="frame">0</div><button id="verify" onclick="this.textContent='Computer Use verified';document.getElementById('result').textContent='clicked'">Verify Computer Use</button><p id="result">not clicked</p><script>let n=0;setInterval(()=>{n++;document.body.style.background='rgb('+((n*37)%180)+','+((n*71)%180)+','+((n*17)%180)+')';document.getElementById('frame').textContent='Generated frame '+n},120)</script>`)}`)
      window.show()
      window.moveTop()
      return window
    } catch (error) { window.destroy(); throw error }
  }
  let source
  let handoff
  let cover
  try {
    source = await createSource(nonce)
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'source-page.png'), (await source.webContents.capturePage()).toPNG())
    const bounds = source.getBounds(), content = source.getContentBounds()
    const markerPositions = {
      left: (content.x - bounds.x + 16) / bounds.width,
      right: (content.x - bounds.x + content.width - 16) / bounds.width,
      top: (content.y - bounds.y + 16) / bounds.height,
      bottom: (content.y - bounds.y + content.height - 16) / bounds.height,
    }
    await evaluate(`async()=>{window[${JSON.stringify(stateKey)}]={disposed:false,stream:undefined,lease:undefined,panel:undefined};return true}`)
    const findSource = () => evaluate(`async()=>{const values=await window.dshDesktop.windowCapture.list();return values.find(value=>value.name===${JSON.stringify(nonce)})??null}`)
    await waitFor(async () => (await findSource()) !== null, 'the owned test source')
    const selected = await findSource()
    const acquire = async () => evaluate(`async()=>{
      const state=window[${JSON.stringify(stateKey)}],api=window.dshDesktop.windowCapture;
      state.lease=await api.prepare(${JSON.stringify(selected.id)});
      const pending=navigator.mediaDevices.getDisplayMedia({audio:false,video:true});
      pending.then(stream=>{if(state.disposed)stream.getTracks().forEach(track=>track.stop())},()=>{});
      let timer;try{state.stream=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Capture initialization timed out')),15000)})])}finally{clearTimeout(timer)}
      if(!await api.validate(state.lease.id))throw new Error('The selected source disappeared during acquisition');
      return {lease:state.lease.id,settings:state.stream.getVideoTracks()[0].getSettings()};
    }`)
    evidence.acquired = await acquire()
    evidence.camera = await evaluate(`async()=>navigator.mediaDevices.getUserMedia({audio:false,video:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return 'unexpectedly allowed'},error=>error.name)`)
    if (evidence.camera !== 'NotAllowedError') throw new Error('Camera permissions were broadened')
    const captured = await evaluate(`async()=>{
      const state=window[${JSON.stringify(stateKey)}],api=window.dshDesktop.windowCapture;
      const panel=document.createElement('div');panel.style.cssText='position:fixed;right:20px;bottom:90px;z-index:2147483647;background:#111;color:white;border:2px solid #66f;border-radius:8px;padding:8px;width:320px;pointer-events:none;font:13px sans-serif';panel.textContent='Generated window mirror · native test';
      const video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;video.style.cssText='display:block;width:100%';video.srcObject=state.stream;panel.append(video);document.body.append(panel);state.panel=panel;state.video=video;await video.play();
      const capture=new ImageCapture(state.stream.getVideoTracks()[0]);
      const points=${JSON.stringify(markerPositions)};
      const inspect=canvas=>{const ctx=canvas.getContext('2d'),at=(x,y)=>Array.from(ctx.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data).slice(0,3);const corners=[at(points.left,points.top),at(points.right,points.top),at(points.left,points.bottom),at(points.right,points.bottom)],expected=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]];return{corners,complete:corners.every((rgb,i)=>rgb.every((v,c)=>Math.abs(v-expected[i][c])<35))}};
      const grab=async()=>{if(!await api.validate(state.lease.id))throw new Error('Source unavailable before screenshot');const bitmap=await capture.grabFrame();try{const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const bytes=ctx.getImageData(0,0,canvas.width,canvas.height).data;let hash=2166136261;for(let i=0;i<bytes.length;i+=16)hash=Math.imul(hash^bytes[i],16777619);if(!await api.validate(state.lease.id))throw new Error('Source unavailable after screenshot');return {width:bitmap.width,height:bitmap.height,hash:hash>>>0,...inspect(canvas),png:canvas.toDataURL('image/png').split(',')[1]}}finally{bitmap.close()}};
      state.grab=grab;const initial=await grab();let first=initial;const deadline=performance.now()+8000;
      while(!first.complete){if(performance.now()>deadline)throw new Error('Full native window markers did not appear');await new Promise(accept=>setTimeout(accept,150));first=await grab()}
      let second=first;while(second.hash===first.hash||!second.complete){if(performance.now()>deadline)throw new Error('Complete native pixels did not update');await new Promise(accept=>setTimeout(accept,150));second=await grab()}
      const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);const videoImage={...inspect(canvas),png:canvas.toDataURL().split(',')[1]};if(!videoImage.complete)throw new Error('Video composition is incomplete');
      return {first,second,videoImage,initialComplete:initial.complete,displaySurface:state.stream.getVideoTracks()[0].getSettings().displaySurface};
    }`)
    writeFileSync(join(artifacts, 'frame-first.png'), Buffer.from(captured.first.png, 'base64'))
    writeFileSync(join(artifacts, 'frame-second.png'), Buffer.from(captured.second.png, 'base64'))
    writeFileSync(join(artifacts, 'video-frame.png'), Buffer.from(captured.videoImage.png, 'base64'))
    evidence.pixels = {
      first: { width: captured.first.width, height: captured.first.height, hash: captured.first.hash, corners: captured.first.corners },
      second: { width: captured.second.width, height: captured.second.height, hash: captured.second.hash, corners: captured.second.corners },
      initialComplete: captured.initialComplete,
      videoComplete: captured.videoImage.complete,
      displaySurface: captured.displaySurface,
    }
    cover = new BrowserWindow({ ...source.getBounds(), show: false, focusable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await cover.loadURL('data:text/html,' + encodeURIComponent('<body style="background:red;color:white;font:28px sans-serif">Owned occluder: must not appear in source mirror</body>'))
    cover.showInactive()
    cover.moveTop()
    const covered = await evaluate(`async()=>{const s=window[${JSON.stringify(stateKey)}];let frame=await s.grab();const deadline=performance.now()+8000;while(frame.hash===${captured.second.hash}||!frame.complete){if(performance.now()>deadline)throw new Error('Occluded source lost complete live content');await new Promise(r=>setTimeout(r,150));frame=await s.grab()}return frame}`)
    writeFileSync(join(artifacts, 'frame-covered.png'), Buffer.from(covered.png, 'base64'))
    evidence.covered = { complete: covered.complete, hash: covered.hash, corners: covered.corners }
    cover.destroy()
    cover = undefined
    source.minimize()
    await waitFor(async () => (await findSource()) === null, 'the minimized source to leave native enumeration')
    evidence.minimized = await evaluate(`async()=>{const s=window[${JSON.stringify(stateKey)}];return {valid:await window.dshDesktop.windowCapture.validate(s.lease.id),track:s.stream.getVideoTracks()[0].readyState}}`)
    if (evidence.minimized.valid) throw new Error('A minimized source retained a valid screenshot reservation')
    const stop = async () => evaluate(`async()=>{const s=window[${JSON.stringify(stateKey)}];s.stream?.getTracks().forEach(track=>track.stop());if(s.lease)await window.dshDesktop.windowCapture.release(s.lease.id);const ended=s.stream?.getTracks().every(track=>track.readyState==='ended')??true;s.stream=undefined;s.lease=undefined;if(s.video)s.video.srcObject=null;return ended}`)
    evidence.firstStopped = await stop()
    source.restore()
    await waitFor(async () => (await findSource()) !== null, 'the restored owned source')
    await acquire()
    source.destroy()
    source = undefined
    await waitFor(async () => (await findSource()) === null, 'the closed source to leave native enumeration')
    evidence.closed = await evaluate(`async()=>{const s=window[${JSON.stringify(stateKey)}];return {valid:await window.dshDesktop.windowCapture.validate(s.lease.id),track:s.stream.getVideoTracks()[0].readyState}}`)
    if (evidence.closed.valid) throw new Error('A closed source retained a valid screenshot reservation')
    evidence.secondStopped = await stop()
    if (!evidence.firstStopped || !evidence.secondStopped) throw new Error('Owned video tracks were not stopped')
    if (keepSource) {
      const title = `${nonce} handoff`
      handoff = await createSource(title)
      evidence.handoff = { title }
    }
    return evidence
  } finally {
    try {
      await evaluate(`async()=>{const s=window[${JSON.stringify(stateKey)}];if(!s)return true;s.disposed=true;s.stream?.getTracks().forEach(track=>track.stop());if(s.lease)await window.dshDesktop.windowCapture.release(s.lease.id);if(s.video)s.video.srcObject=null;s.panel?.remove();delete window[${JSON.stringify(stateKey)}];return true}`)
    } finally {
      if (source && !source.isDestroyed()) source.destroy()
      if (cover && !cover.isDestroyed()) cover.destroy()
      if (handoff && !evidence.handoff) handoff.destroy()
    }
  }
}

try {
  const result = await call('Runtime.evaluate', {
    expression: `(${nativeFixture.toString()})(${JSON.stringify({ artifacts: resolve(values.artifacts), keepSource: values['keep-source'] })})`,
    awaitPromise: true, returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  const evidence = result.result.value
  await writeFile(resolve(values.artifacts, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
} finally { socket.close() }
