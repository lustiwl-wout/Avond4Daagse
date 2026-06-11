// Laadtest voor de frontend-scripts: voert elk script uit met stub-DOM en
// stub-Leaflet en faalt als het script bij het laden crasht (zoals een
// verwijzing naar state die pas later bestaat). Gebruik: node scripts/check-frontend.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function stubElement() {
  const el = {};
  const fn = () => stubElement();
  return new Proxy(el, {
    get(target, prop) {
      if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === 'style' || prop === 'dataset') return {};
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return target[prop] || '';
      if (prop === 'length') return 0;
      if (prop === Symbol.iterator) return [][Symbol.iterator];
      if (!(prop in target)) target[prop] = (...args) => (prop === 'querySelectorAll' ? [] : fn(args));
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function layerStub() {
  const layer = {};
  const self = new Proxy(layer, {
    get(target, prop) {
      if (prop === 'then') return undefined; // geen thenable
      if (!(prop in target)) {
        target[prop] = (...args) => {
          if (prop === 'getLatLng') return { lat: 52.35, lng: 5.26 };
          if (prop === 'hasLayer') return false;
          if (prop === 'getSouthWest' || prop === 'getNorthEast') return { lat: 52.35, lng: 5.26 };
          return self;
        };
      }
      return target[prop];
    },
  });
  return self;
}

function buildSandbox() {
  const documentStub = {
    getElementById: () => stubElement(),
    querySelector: () => stubElement(),
    querySelectorAll: () => [],
    createElement: () => stubElement(),
    head: stubElement(),
    body: stubElement(),
    addEventListener() {},
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Intl,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Promise,
    document: documentStub,
    location: { search: '', href: 'http://localhost/' },
    navigator: { geolocation: { watchPosition: () => 1, clearWatch() {} } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    alert() {},
    confirm: () => false,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    ResizeObserver: class { observe() {} disconnect() {} },
    L: {
      map: () => layerStub(),
      tileLayer: () => layerStub(),
      polyline: () => layerStub(),
      marker: () => layerStub(),
      circle: () => layerStub(),
      divIcon: () => ({}),
      popup: () => layerStub(),
      latLngBounds: () => layerStub(),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

const pages = {
  'app.js': ['map-common.js', 'gps.js', 'app.js'],
  'verkeer.js': ['map-common.js', 'gps.js', 'verkeer.js'],
  'admin.js': ['map-common.js', 'gps.js', 'admin.js'],
  'print.js': ['map-common.js', 'print.js'],
};

let failed = false;
for (const [name, files] of Object.entries(pages)) {
  const sandbox = buildSandbox();
  const rejections = [];
  sandbox.Promise = Promise;
  vm.createContext(sandbox);
  try {
    for (const file of files) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
      vm.runInContext(code, sandbox, { filename: file });
    }
    console.log(`OK   ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FOUT ${name}: ${err.message}`);
    console.error(err.stack.split('\n').slice(0, 3).join('\n'));
  }
  void rejections;
}

process.exit(failed ? 1 : 0);
