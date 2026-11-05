import { api } from './shared.js';

const defaultCenter = { lat:-19.9235, lng:-43.9381 };
const authError = 'O Google Maps está indisponível. Você pode usar o GPS.';
let loading;
let rejected = false;
const failures = new Set();

window.gm_authFailure = () => {
  rejected = true;
  for (const fail of failures) fail(authError);
};

function loadMaps() {
  if (rejected) return Promise.reject(new Error(authError));
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  loading ??= api('maps/browser-config').then(({ key }) => new Promise((resolve,reject) => {
    const callback = 'fdGoogleMapsReady';
    const script = document.createElement('script');
    const finish = (error) => {
      clearTimeout(timeout);
      failures.delete(failed);
      delete window[callback];
      if (error) {
        script.remove();
        reject(new Error(error));
      } else resolve(window.google.maps);
    };
    const failed = message => finish(message);
    const timeout = setTimeout(() => finish(authError),12000);
    window[callback] = () => rejected || !window.google?.maps?.Map ? finish(authError) : finish();
    failures.add(failed);
    const parameters = new URLSearchParams({ key, v:'weekly', language:'pt-BR', region:'BR', loading:'async', callback });
    script.src = 'https://maps.googleapis.com/maps/api/js?' + parameters;
    script.async = true;
    script.onerror = () => finish(authError);
    document.head.append(script);
  })).catch(error => { loading = null; throw error; });
  return loading;
}

export function mapPicker(element, selected, center = defaultCenter, onSelect = () => {}) {
  let active = true;
  let map;
  let marker;
  let point = selected;
  const listeners = [];

  function fail(message) {
    if (!active) return;
    element.textContent = message;
    element.classList.add('map-message');
  }

  function placeMarker(moveMap) {
    if (!map || !point || !active || rejected) return;
    const maps = window.google.maps;
    if (!marker) {
      marker = new maps.Marker({
        map, position:point, draggable:true, title:'Ponto selecionado',
        icon:{ url:'/assets/map-pin.svg', scaledSize:new maps.Size(40,40), anchor:new maps.Point(20,36) }
      });
      listeners.push(marker.addListener('dragend',event => select(event.latLng.toJSON(),false)));
    } else marker.setPosition(point);
    if (moveMap) map.panTo(point);
  }

  function select(value, moveMap = true) {
    if (!active) return;
    point = { lat:value.lat, lng:value.lng };
    onSelect(point);
    placeMarker(moveMap);
  }

  element.textContent = 'Carregando Google Maps…';
  element.classList.add('map-message');
  failures.add(fail);
  if (point) onSelect(point);
  loadMaps().then(maps => {
    if (!active || rejected) return;
    element.textContent = '';
    element.classList.remove('map-message');
    map = new maps.Map(element,{
      center:point ?? { lat:center.lat, lng:center.lng }, zoom:15,
      streetViewControl:false, mapTypeControl:false, fullscreenControl:false, clickableIcons:false
    });
    listeners.push(map.addListener('click',event => select(event.latLng.toJSON(),false)));
    placeMarker(false);
  }).catch(error => fail(error.message));

  return {
    set:select,
    remove() {
      active = false;
      failures.delete(fail);
      for (const listener of listeners) listener.remove();
      marker?.setMap(null);
      element.replaceChildren();
      map = null;
    }
  };
}
