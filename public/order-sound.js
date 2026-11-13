const preference = 'fd-order-sound:' + location.pathname;
const Audio = window.AudioContext ?? window.webkitAudioContext;
let context;
let enabled = false;
try { enabled = localStorage.getItem(preference) === 'on'; } catch {}
const played = new Set();

async function unlock() {
  context ??= new Audio();
  if (context.state !== 'running') await context.resume();
}

function unlockOnInteraction(event) {
  if (enabled && Audio && event.isTrusted) void unlock().catch(() => {});
}
window.addEventListener('click',unlockOnInteraction,{capture:true});
window.addEventListener('keydown',unlockOnInteraction,{capture:true});

function chime() {
  const start = context.currentTime;
  for (const [index,frequency] of [660,880].entries()) {
    const time = start + index * .13;
    const tone = context.createOscillator();
    const volume = context.createGain();
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(.001,time);
    volume.gain.exponentialRampToValueAtTime(.16,time+.025);
    volume.gain.exponentialRampToValueAtTime(.001,time+.19);
    tone.connect(volume).connect(context.destination);
    tone.start(time);
    tone.stop(time+.2);
  }
}

export function playOrderSound(eventId) {
  if (!enabled || document.visibilityState !== 'visible' || context?.state !== 'running' || played.has(eventId)) return;
  if (played.size >= 80) played.delete(played.values().next().value);
  played.add(eventId);
  chime();
}

export function bindOrderSound(root) {
  if (!Audio) return;
  const button = root.querySelector('[data-order-sound]');
  const label = root.querySelector('[data-order-sound-status]');
  button.hidden = false;
  function update() {
    button.textContent = enabled ? 'Desativar som de pedidos' : 'Ativar e testar som de pedidos';
    label.textContent = enabled ? 'Som de pedidos ativado neste aparelho.' : '';
  }
  update();
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (!enabled) {
        await unlock();
        if (context.state !== 'running') throw new Error();
        chime();
      }
      enabled = !enabled;
      try { localStorage.setItem(preference,enabled ? 'on' : 'off'); } catch {}
      update();
    } catch {
      label.textContent = 'Toque novamente para liberar o som.';
    } finally { button.disabled = false; }
  };
}

navigator.serviceWorker?.addEventListener('message',event=>{
  if (event.data?.type === 'fly-delivery-order' && typeof event.data.orderEvent === 'string') {
    playOrderSound(event.data.orderEvent);
  }
});
