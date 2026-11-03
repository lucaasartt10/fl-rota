
/* =========================================================
   FL ROTA - APP.JS
   Fluxo: criar rota -> salvar -> consultar -> navegar
   Endereço é a referência da entrega; código de barras não é usado.
========================================================= */

const $ = id => document.getElementById(id);

const readStorage = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

let parcels = readStorage('flrota.parcels', []);
let home = readStorage('flrota.home', null);
let savedRoute = readStorage('flrota.savedRoute', null);
let routeStops = [];
let stream = null;
let ocrBusy = false;
let map = null;
let driverMarker = null;
let deliveryMarkers = [];
let routeLayer = null;
let locationWatchId = null;
let currentPosition = null;
let navigationActive = false;
let routingBusy = false;
let appMode = 'create';
let pendingReviewMode = 'create';
let recognition = null;

window.flrotaOrder = [];

function on(id, event, callback) {
  const el = $(id);
  if (el) el.addEventListener(event, callback);
}

function setText(id, value) {
  if ($(id)) $(id).textContent = value;
}

function setValue(id, value) {
  if ($(id)) $(id).value = value;
}

function status(message) {
  setText('ocrStatus', message);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function normalizeAddress(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\bR\.\s*/g, 'RUA ')
    .replace(/\bAV\.\s*/g, 'AVENIDA ')
    .replace(/\bN[º°.]?\s*/g, ' ')
    .replace(/[.,;#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressKey(value) {
  return normalizeAddress(value);
}

function saveData() {
  localStorage.setItem('flrota.parcels', JSON.stringify(parcels));
  localStorage.setItem('flrota.savedRoute', JSON.stringify(savedRoute));
  render();
}

function isLocated(p) {
  return Number.isFinite(Number(p.lat)) &&
    Number.isFinite(Number(p.lon)) &&
    p.lat !== null &&
    p.lon !== null;
}

function buildStops(source = parcels) {
  const groups = new Map();

  source.forEach(p => {
    const key = addressKey(p.address);

    if (!key) return;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        address: p.address,
        packages: [],
        lat: isLocated(p) ? Number(p.lat) : null,
        lon: isLocated(p) ? Number(p.lon) : null
      });
    }

    const g = groups.get(key);
    g.packages.push(p);

    if (
      (!Number.isFinite(Number(g.lat)) ||
       !Number.isFinite(Number(g.lon))) &&
      isLocated(p)
    ) {
      g.lat = Number(p.lat);
      g.lon = Number(p.lon);
    }
  });

  return [...groups.values()];
}

function render() {
  const groups = buildStops();

  setText(
    'packageCount',
    `${parcels.length} ${parcels.length === 1 ? 'pacote' : 'pacotes'}`
  );

  setText(
    'destinationCount',
    `${groups.length} ${groups.length === 1 ? 'destino' : 'destinos'}`
  );

  const progress = $('packageProgress');

  if (progress) {
    progress.style.width =
      savedRoute && parcels.length ? '100%' : '0%';
  }

  const list = $('list');

  if (!list) return;

  if (!groups.length) {
    list.innerHTML =
      '<div class="empty">Nenhum endereço cadastrado.<br>Use a câmera ou o microfone para começar.</div>';
    return;
  }

  const order = savedRoute?.stops?.length
    ? savedRoute.stops
    : groups;

  list.innerHTML = order.map((stop, i) => {
    const group =
      groups.find(g => g.key === stop.key) || stop;

    const number = stop.stopNumber || i + 1;

    return `
      <div class="stop">
        <div class="stop-number">${number}</div>
        <div class="stop-info">
          <strong>${escapeHtml(group.address)}</strong>
          <small>${group.packages?.length || group.packageCount || 1} pacote(s) neste endereço</small>
        </div>
        <span class="stop-count">PARADA ${number}</span>
      </div>
    `;
  }).join('');
}

/* CONFIRMAÇÃO DO ENDEREÇO */

function openReview(address, mode = 'create') {
  if (!address || !String(address).trim()) {
    alert('Não consegui identificar o endereço. Tente novamente ou digite manualmente.');
    return;
  }

  pendingReviewMode = mode;
  setValue('reviewAddress', address.trim());
  $('reviewDialog')?.showModal();
}

on('cancelReview', 'click', () => {
  $('reviewDialog')?.close();
});

on('confirmReview', 'click', async () => {
  const address = $('reviewAddress')?.value.trim();

  if (!address) {
    alert('Informe o endereço.');
    return;
  }

  $('reviewDialog')?.close();

  if (pendingReviewMode === 'lookup') {
    await lookupAddress(address);
  } else {
    parcels.push({
      address,
      done: false,
      created: Date.now(),
      lat: null,
      lon: null
    });

    savedRoute = null;

    saveData();

    status('Endereço cadastrado. Você pode adicionar o próximo pacote.');

    await recalcPreview();
  }
});

on('addTypedBtn', 'click', () => {
  openReview($('addressSearch')?.value || '');
});

on('addressSearch', 'keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    openReview(e.target.value);
    e.target.value = '';
  }
});

on('saveRouteBtn', 'click', saveRoute);

on('rebuildBtn', 'click', () => {
  savedRoute = null;
  saveData();
  recalcPreview();
});

/* MODOS DE CRIAÇÃO E CONSULTA */

on('createModeBtn', 'click', () => setMode('create'));
on('lookupModeBtn', 'click', () => setMode('lookup'));

function setMode(mode) {
  appMode = mode;

  $('createPanel')?.classList.toggle('hidden', mode !== 'create');
  $('lookupPanel')?.classList.toggle('hidden', mode !== 'lookup');

  $('createModeBtn')?.classList.toggle('active', mode === 'create');
  $('lookupModeBtn')?.classList.toggle('active', mode === 'lookup');

  setText(
    'screenTitle',
    mode === 'create'
      ? 'Monte sua rota'
      : 'Consulte uma entrega'
  );

  setText(
    'screenSubtitle',
    mode === 'create'
      ? 'Cadastre os destinos e organize suas entregas.'
      : 'Descubra o número da parada pelo endereço.'
  );

  setText(
    'mapModeLabel',
    mode === 'create'
      ? 'MAPA DA ROTA'
      : 'CONSULTA DE ENDEREÇO'
  );
}

/* CONSULTA DE PACOTES */

on('lookupSearchBtn', 'click', () => {
  lookupAddress($('lookupAddress')?.value || '');
});

on('lookupAddress', 'keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    lookupAddress(e.target.value);
  }
});

async function lookupAddress(address) {
  if (!savedRoute?.stops?.length) {
    setText(
      'lookupResult',
      'Você ainda não salvou uma rota. Crie e salve a rota primeiro.'
    );
    return;
  }

  const key = addressKey(address);

  const found = savedRoute.stops.find(s => s.key === key);

  if (found) {
    setText(
      'lookupResult',
      `ENTREGA Nº ${found.stopNumber} — ${found.packageCount} PACOTE(S) NESTE ENDEREÇO\n${found.address}`
    );
  } else {
    setText(
      'lookupResult',
      'Endereço não encontrado na rota salva. Confira o número, bairro e complemento.'
    );
  }

  setText(
    'lookupStatus',
    'Consulta concluída. A rota não foi alterada.'
  );
}

/* CÂMERA E LEITURA DA ETIQUETA */

on('scanBtn', 'click', () => openLabelCamera('create'));
on('lookupScanBtn', 'click', () => openLabelCamera('lookup'));

function openLabelCamera(mode) {
  pendingReviewMode = mode;
  $('ocrFile')?.click();
}

on('ocrFile', 'change', async e => {
  const file = e.target.files?.[0];

  if (!file) return;

  await readLabelOCR(file, pendingReviewMode);

  e.target.value = '';
});

async function readLabelOCR(file, mode) {
  if (ocrBusy) {
    alert('Aguarde a leitura atual terminar.');
    return;
  }

  if (!window.Tesseract) {
    alert('Leitor de texto não carregou. Confira a conexão.');
    return;
  }

  ocrBusy = true;

  status('Lendo etiqueta...');

  try {
    const result = await Tesseract.recognize(
      file,
      'por+eng',
      {
        logger: m => {
          if (m.status === 'recognizing text') {
            status(
              `Lendo etiqueta... ${Math.round((m.progress || 0) * 100)}%`
            );
          }
        }
      }
    );

    const raw = (result?.data?.text || '').trim();

    console.log('OCR:', raw);

    const parsed = parseLabelText(raw);

    if (!parsed.address) {
      status('Não identifiquei um endereço com segurança.');

      alert(
        'Não consegui separar o endereço da etiqueta. Tente outra foto ou use o microfone/digitação.'
      );

      return;
    }

    openReview(parsed.address, mode);

    status('Leitura concluída. Confira o endereço.');

  } catch (err) {
    console.error(err);

    status('Falha na leitura da etiqueta.');

    alert('Erro ao ler a etiqueta. Tente novamente.');

  } finally {
    ocrBusy = false;
  }
}

function parseLabelText(raw) {
  const lines = raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map(x => x.replace(/\s+/g, ' ').trim())
    .filter(x => x.length > 2);

  const clean = lines.filter(line =>
    !/RASTREAMENTO|TRACKING|CODIGO DE BARRAS|PEDIDO|ORDER|SHOPEE|SHEIN|TIKTOK|REMETENTE|CNPJ|CPF|TELEFONE|BARCODE|VOLUME|PESO/i.test(line)
  );

  const street =
    /\b(RUA|R\.|AVENIDA|AV\.|TRAVESSA|ESTRADA|RODOVIA|ALAMEDA|PRACA|LARGO|VIELA)\b/i;

  let i = clean.findIndex(x =>
    /DESTINATARIO|ENTREGA|SHIP TO|RECEIVER|ENDERECO DE ENTREGA/i.test(x)
  );

  let selected = i >= 0
    ? clean.slice(i + 1, i + 8)
    : [];

  if (!selected.some(x => street.test(x))) {
    i = clean.findIndex(x => street.test(x));

    selected = i >= 0
      ? clean.slice(i, i + 6)
      : [];
  }

  selected = selected.filter(x =>
    !/^DESTINATARIO|ENTREGA|SHIP TO/i.test(x)
  );

  return {
    address: [...new Set(selected)].join(', ')
  };
}

/* RECONHECIMENTO DE VOZ */

function startVoice(mode = 'create') {
  const Speech =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!Speech) {
    alert(
      'O reconhecimento de voz não está disponível neste navegador. Você pode digitar o endereço ou usar a câmera.'
    );
    return;
  }

  if (recognition) {
    try {
      recognition.stop();
    } catch {}
  }

  recognition = new Speech();

  recognition.lang = 'pt-BR';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  status('Pode falar o endereço...');

  recognition.onresult = e => {
    const spoken =
      e.results?.[0]?.[0]?.transcript || '';

    status('Voz reconhecida. Confira o endereço.');

    openReview(spoken, mode);
  };

  recognition.onerror = e => {
    status('Não foi possível reconhecer a fala.');

    alert(
      'Não consegui reconhecer o endereço. Tente novamente ou digite.'
    );
  };

  recognition.onend = () => {
    recognition = null;
  };

  recognition.start();
}

on('voiceBtn', 'click', () => startVoice('create'));
on('lookupVoiceBtn', 'click', () => startVoice('lookup'));

/* PONTO DE PARTIDA E GPS */

on('homeBtn', 'click', () => {
  setValue('homeAddress', home?.address || '');
  $('homeDialog')?.showModal();
});

on('closeHome', 'click', () => {
  $('homeDialog')?.close();
});

on('saveHome', 'click', async () => {
  const address = $('homeAddress')?.value.trim();

  if (!address) {
    alert('Informe o endereço de saída.');
    return;
  }

  home = {
    address,
    lat: null,
    lon: null
  };

  localStorage.setItem(
    'flrota.home',
    JSON.stringify(home)
  );

  $('homeDialog')?.close();

  await recalcPreview();
});

on('geoBtn', 'click', async () => {
  const pos = await getCurrentLocation(true);

  if (pos) {
    home = {
      address: 'Minha localização atual',
      lat: pos.lat,
      lon: pos.lon
    };

    localStorage.setItem(
      'flrota.home',
      JSON.stringify(home)
    );

    $('homeDialog')?.close();

    await recalcPreview();
  }
});

function getCurrentLocation() {
  if (!navigator.geolocation) {
    alert('GPS não disponível.');
    return Promise.resolve(null);
  }

  setText('gpsBadge', 'GPS • LOCALIZANDO');

  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      p => {
        const pos = {
          lat: p.coords.latitude,
          lon: p.coords.longitude
        };

        currentPosition = pos;

        updateDriverPosition(pos.lat, pos.lon);

        setText('gpsBadge', 'GPS • ATIVO');

        resolve(pos);
      },

      err => {
        console.warn(err);

        setText('gpsBadge', 'GPS • INDISPONÍVEL');

        resolve(null);
      },

      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 5000
      }
    );
  });
}

function startLocationTracking() {
  if (!navigator.geolocation) return;

  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
  }

  locationWatchId = navigator.geolocation.watchPosition(
    p => {
      currentPosition = {
        lat: p.coords.latitude,
        lon: p.coords.longitude
      };

      updateDriverPosition(
        currentPosition.lat,
        currentPosition.lon
      );

      setText('gpsBadge', 'GPS • ATIVO');
    },

    e => console.warn('GPS', e),

    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 10000
    }
  );
}

function updateDriverPosition(lat, lon) {
  if (!map) return;

  const icon = L.divIcon({
    className: '',
    html: '<div class="driver-marker"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  if (!driverMarker) {
    driverMarker = L.marker(
      [lat, lon],
      {
        icon,
        zIndexOffset: 1000
      }
    )
      .addTo(map)
      .bindPopup('Você está aqui');
  } else {
    driverMarker.setLatLng([lat, lon]);
  }
}

/* MAPA */

function initMap() {
  if (map || !window.L || !$('map')) return;

  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([-23.5505, -46.6333], 12);

  L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  ).addTo(map);

  const control = L.control({
    position: 'topright'
  });

  control.onAdd = () => {
    const b = L.DomUtil.create(
      'button',
      'map-location-control'
    );

    b.type = 'button';
    b.textContent = '⌖';
    b.title = 'Minha localização';

    L.DomEvent.disableClickPropagation(b);

    L.DomEvent.on(b, 'click', async () => {
      const p =
        currentPosition || await getCurrentLocation();

      if (p) map.setView([p.lat, p.lon], 17);
    });

    return b;
  };

  control.addTo(map);

  setTimeout(() => map.invalidateSize(), 400);
}

function clearMapLayers() {
  deliveryMarkers.forEach(m => map?.removeLayer(m));

  deliveryMarkers = [];

  if (routeLayer && map) {
    map.removeLayer(routeLayer);
  }

  routeLayer = null;
}

function drawStops(stops) {
  clearMapLayers();

  if (!map) return;

  stops.forEach(s => {
    if (
      !Number.isFinite(Number(s.lat)) ||
      !Number.isFinite(Number(s.lon))
    ) return;

    const icon = L.divIcon({
      className: '',
      html: `
        <div class="delivery-marker">
          <span>${s.stopNumber}</span>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 34]
    });

    const marker = L.marker(
      [s.lat, s.lon],
      { icon }
    ).addTo(map);

    marker.bindPopup(
      `<b>Entrega ${s.stopNumber}</b><br>${escapeHtml(s.address)}<br>${s.packageCount} pacote(s)`
    );

    deliveryMarkers.push(marker);
  });
}

/* GEOCODIFICAÇÃO */

async function geocode(address) {
  try {
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=' +
      encodeURIComponent(address + ', Brasil');

    const r = await fetch(url, {
      headers: {
        Accept: 'application/json'
      }
    });

    if (!r.ok) {
      throw Error('Geocodificação HTTP ' + r.status);
    }

    const data = await r.json();

    if (!data.length) return null;

    return {
      lat: Number(data[0].lat),
      lon: Number(data[0].lon)
    };

  } catch (e) {
    console.warn('Geocode', e);
    return null;
  }
}

function haversine(a, b) {
  const rad = x => x * Math.PI / 180;

  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) *
    Math.cos(rad(b.lat)) *
    Math.sin(dLon / 2) ** 2;

  return 6371 * 2 *
    Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/* ORDENAÇÃO APROXIMADA DOS DESTINOS */

async function optimizeStops(start, stops) {
  if (stops.length < 2) return stops;

  const remaining = [...stops];
  const ordered = [];
  let current = start;

  while (remaining.length) {
    remaining.sort(
      (a, b) => haversine(current, a) - haversine(current, b)
    );

    const next = remaining.shift();

    ordered.push(next);

    current = next;
  }

  return ordered;
}

/* TRAJETO PELAS RUAS */

async function getRoadRoute(start, stops) {
  if (!stops.length) return null;

  const coords = [
    start,
    ...stops
  ]
    .map(p => `${p.lon},${p.lat}`)
    .join(';');

  try {
    const r = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`
    );

    if (!r.ok) {
      throw Error('OSRM route HTTP ' + r.status);
    }

    const d = await r.json();

    return d.code === 'Ok'
      ? d.routes?.[0] || null
      : null;

  } catch (e) {
    console.warn(e);
    return null;
  }
}

function drawRoute(route) {
  if (routeLayer && map) {
    map.removeLayer(routeLayer);
  }

  routeLayer = null;

  if (!map || !route?.geometry) return;

  routeLayer = L.geoJSON(
    route.geometry,
    {
      style: {
        color: '#ff3038',
        weight: 6,
        opacity: .95,
        lineCap: 'round',
        lineJoin: 'round'
      }
    }
  ).addTo(map);

  const bounds = routeLayer.getBounds();

  if (bounds.isValid()) {
    map.fitBounds(
      bounds,
      { padding: [35, 35] }
    );
  }
}

function updateRouteInfo(route, count) {
  setText('routeStops', count || 0);

  if (!route) {
    setText('routeDistance', '--');
    setText('routeTime', '--');
    return;
  }

  setText(
    'routeDistance',
    (route.distance / 1000).toFixed(1) + ' km'
  );

  const m = Math.round(route.duration / 60);

  setText(
    'routeTime',
    m < 60
      ? `${m} min`
      : `${Math.floor(m / 60)}h ${m % 60}min`
  );
}

/* PREPARAÇÃO DOS DESTINOS */

async function getStartPoint() {
  if (home?.lat != null && home?.lon != null) {
    return {
      lat: Number(home.lat),
      lon: Number(home.lon)
    };
  }

  if (
    home?.address &&
    home.address !== 'Minha localização atual'
  ) {
    const p = await geocode(home.address);

    if (p) return p;
  }

  if (currentPosition) return currentPosition;

  return await getCurrentLocation();
}

async function prepareStops() {
  const groups = buildStops();

  for (const g of groups) {
    if (
      !Number.isFinite(Number(g.lat)) ||
      !Number.isFinite(Number(g.lon))
    ) {
      const p = await geocode(g.address);

      if (p) {
        g.lat = p.lat;
        g.lon = p.lon;

        g.packages.forEach(pkg => {
          pkg.lat = p.lat;
          pkg.lon = p.lon;
        });
      }
    }
  }

  return groups.filter(g =>
    Number.isFinite(Number(g.lat)) &&
    Number.isFinite(Number(g.lon))
  );
}

async function recalcPreview() {
  if (routingBusy) return;

  routingBusy = true;

  try {
    if (!parcels.length) {
      updateRouteInfo(null, 0);
      return;
    }

    status('Localizando endereços e organizando destinos...');

    const stops = await prepareStops();

    if (!stops.length) {
      status(
        'Não foi possível localizar os endereços. Confira cidade, bairro e CEP.'
      );
      return;
    }

    const start = await getStartPoint();

    if (!start) {
      status('Defina o ponto de partida ou permita o GPS.');
      return;
    }

    const ordered = await optimizeStops(start, stops);

    ordered.forEach((s, i) => {
      s.stopNumber = i + 1;
    });

    const route = await getRoadRoute(start, ordered);

    drawStops(ordered);

    if (route) drawRoute(route);

    updateRouteInfo(route, ordered.length);

    status(
      'Prévia da rota atualizada. Confira os endereços antes de salvar.'
    );

    saveData();

  } finally {
    routingBusy = false;
  }
}

/* SALVAR A ROTA */

async function saveRoute() {
  if (!parcels.length) {
    alert('Cadastre pelo menos um endereço antes de salvar a rota.');
    return;
  }

  if (routingBusy) return;

  routingBusy = true;

  status('Preparando e organizando sua rota...');

  try {
    const stops = await prepareStops();

    if (!stops.length) {
      alert(
        'Não consegui localizar os endereços. Confira os dados e tente novamente.'
      );
      return;
    }

    const start = await getStartPoint();

    if (!start) {
      alert(
        'Defina o ponto de partida ou permita o GPS.'
      );
      return;
    }

    const ordered = await optimizeStops(start, stops);

    ordered.forEach((s, i) => {
      s.stopNumber = i + 1;
      s.packageCount = s.packages.length;
    });

    const route = await getRoadRoute(start, ordered);

    savedRoute = {
      savedAt: Date.now(),

      stops: ordered.map(s => ({
        key: s.key,
        address: s.address,
        lat: s.lat,
        lon: s.lon,
        stopNumber: s.stopNumber,
        packageCount: s.packageCount
      })),

      distance: route?.distance || null,
      duration: route?.duration || null
    };

    drawStops(ordered);

    if (route) drawRoute(route);

    updateRouteInfo(route, ordered.length);

    saveData();

    setMode('lookup');

    status(
      'Rota salva! Agora você pode consultar a numeração dos pacotes.'
    );

    alert(
      'Rota salva com sucesso! Agora use CONSULTAR PACOTE para identificar o número de cada parada.'
    );

  } catch (e) {
    console.error(e);

    alert(
      'Não foi possível salvar a rota. Tente novamente.'
    );

  } finally {
    routingBusy = false;
  }
}

/* NAVEGAÇÃO */

on('navBtn', 'click', async () => {
  if (!savedRoute?.stops?.length) {
    alert('Primeiro crie e salve sua rota.');
    return;
  }

  if (!navigationActive) {
    const p = await getCurrentLocation();

    if (!p) {
      alert(
        'Ative a localização do aparelho para iniciar.'
      );
      return;
    }

    navigationActive = true;

    setText('navBtn', 'ENCERRAR NAVEGAÇÃO');

    startLocationTracking();

    map?.setView([p.lat, p.lon], 16);

    status(
      'Navegação iniciada. Siga a rota vermelha no mapa.'
    );

  } else {
    navigationActive = false;

    if (locationWatchId !== null) {
      navigator.geolocation.clearWatch(locationWatchId);
      locationWatchId = null;
    }

    setText('navBtn', 'INICIAR ROTA →');

    status('Navegação encerrada.');
  }
});

/* MENU INFERIOR */

on('tabHome', 'click', () => {
  setMode('create');

  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
});

on('tabStops', 'click', () => {
  setMode('lookup');

  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
});

on('tabMap', 'click', () => {
  $('map')?.scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });

  setTimeout(() => map?.invalidateSize(), 350);
});

on('tabSettings', 'click', () => {
  $('homeDialog')?.showModal();
});

/* INICIALIZAÇÃO */

function initializeApp() {
  render();

  initMap();

  startLocationTracking();

  if (savedRoute?.stops?.length) {
    const stops = savedRoute.stops;

    drawStops(stops);

    setText('routeStops', stops.length);

    if (savedRoute.distance) {
      setText(
        'routeDistance',
        (savedRoute.distance / 1000).toFixed(1) + ' km'
      );
    }

    if (savedRoute.duration) {
      const m = Math.round(savedRoute.duration / 60);

      setText(
        'routeTime',
        m < 60
          ? `${m} min`
          : `${Math.floor(m / 60)}h ${m % 60}min`
      );
    }

    setMode('lookup');

  } else if (parcels.length) {
    setTimeout(() => recalcPreview(), 900);
  }

  setTimeout(() => map?.invalidateSize(), 700);
}

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    initializeApp,
    { once: true }
  );
} else {
  initializeApp();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch(e => console.warn('SW', e));
  });
}

window.addEventListener('error', e => {
  console.error(
    'FL ROTA erro:',
    e.message,
    e.filename,
    e.lineno
  );
});

console.log('FL ROTA: app.js carregado.');
