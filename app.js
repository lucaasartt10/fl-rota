/* =========================================================
   FL ROTA - APP.JS
   Versão com inicialização protegida do mapa
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

let pendingCode = '';
let stream = null;
let ocrBusy = false;

let map = null;
let driverMarker = null;
let deliveryMarkers = [];
let routeLayer = null;
let locationWatchId = null;
let currentPosition = null;
let navigationActive = false;
let lastRoutePosition = null;
let routingBusy = false;
let mapStarting = false;

window.flrotaOrder = [];

/* =========================================================
   PROTEÇÃO DOS ELEMENTOS HTML
========================================================= */

function on(id, event, callback) {
  const element = $(id);
  if (element) element.addEventListener(event, callback);
  else console.warn('Elemento HTML não encontrado:', id);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setValue(id, value) {
  const element = $(id);
  if (element) element.value = value;
}

function showMapError(message) {
  console.error(message);
  setMapStatus(message);
}

/* =========================================================
   UTILIDADES
========================================================= */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function save() {
  localStorage.setItem('flrota.parcels', JSON.stringify(parcels));
  render();
  recalc();
}

function render() {
  setText('count', parcels.length);
  setText('pending', parcels.filter(p => !p.done).length);
  setText('done', parcels.filter(p => p.done).length);

  const list = $('list');
  if (!list) return;

  list.innerHTML = parcels.length
    ? parcels.map((p, i) => `
      <div class="parcel">
        <span class="pill">${p.done ? 'Entregue' : 'Pendente'}</span>
        <strong>${escapeHtml(p.address)}</strong>
        <small>
          ${escapeHtml(p.code || 'Sem código')}
          ·
          ${p.lat !== null && p.lon !== null ? 'Localizado' : 'Aguardando localização'}
        </small>
        <div style="display:flex;gap:7px;margin-top:9px">
          <button class="secondary"
            style="padding:7px 10px;font-size:11px"
            onclick="toggleDone(${i})">
            ${p.done ? 'Reabrir' : 'Marcar entregue'}
          </button>
          <button class="danger"
            style="padding:7px 10px;font-size:11px"
            onclick="removeParcel(${i})">
            Excluir
          </button>
        </div>
      </div>
    `).join('')
    : '<div class="muted">Nenhum pacote cadastrado ainda.</div>';
}

/* =========================================================
   PACOTES
========================================================= */

window.toggleDone = i => {
  if (!parcels[i]) return;
  parcels[i].done = !parcels[i].done;
  save();
};

window.removeParcel = i => {
  if (!parcels[i]) return;
  parcels.splice(i, 1);
  save();
};

function review(code, address) {
  pendingCode = code || '';

  setValue('reviewCode', code || '');
  setValue('reviewAddress', address || '');

  const dialog = $('reviewDialog');

  if (dialog && !dialog.open) dialog.showModal();

  $('reviewAddress')?.focus();
}

on('cancelReview', 'click', () => {
  $('reviewDialog')?.close();
});

on('confirmReview', 'click', () => {
  const code = $('reviewCode')?.value.trim() || '';
  const address = $('reviewAddress')?.value.trim() || '';

  if (!address) {
    alert('Informe o endereço antes de salvar.');
    return;
  }

  if (code && parcels.some(p => p.code === code)) {
    alert('Esse código já foi cadastrado.');
    return;
  }

  if (parcels.some(p =>
    String(p.address).toLowerCase() === address.toLowerCase() && !p.done
  )) {
    alert('Esse endereço já está cadastrado como pendente.');
    return;
  }

  parcels.push({
    code,
    address,
    done: false,
    created: Date.now(),
    lat: null,
    lon: null
  });

  $('reviewDialog')?.close();

  setValue('code', '');
  setValue('address', '');

  save();
});

on('addBtn', 'click', () => {
  review(
    $('code')?.value.trim() || '',
    $('address')?.value.trim() || ''
  );
});

on('manualBtn', 'click', () => {
  $('code')?.focus();
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: 'smooth'
  });
});

on('clearBtn', 'click', () => {
  if (confirm('Apagar todos os pacotes deste aparelho?')) {
    parcels = [];
    window.flrotaOrder = [];
    save();
  }
});

/* =========================================================
   PONTO DE PARTIDA
========================================================= */

on('homeBtn', 'click', () => {
  setValue('homeAddress', home?.address || '');
  $('homeDialog')?.showModal();
});

on('saveHome', 'click', async () => {
  const address = $('homeAddress')?.value.trim() || '';

  if (!address) {
    alert('Informe o endereço de partida.');
    return;
  }

  home = {
    address,
    lat: home?.lat ?? null,
    lon: home?.lon ?? null
  };

  localStorage.setItem('flrota.home', JSON.stringify(home));
  $('homeDialog')?.close();

  await recalc();
});

on('geoBtn', 'click', () => getCurrentLocation(true));

/* =========================================================
   GPS
========================================================= */

function getCurrentLocation(showAlert = false) {
  if (!navigator.geolocation) {
    if (showAlert) alert('Geolocalização não disponível neste aparelho.');
    return Promise.resolve(null);
  }

  setMapStatus('Obtendo localização do motorista...');

  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => {
        const coords = {
          lat: position.coords.latitude,
          lon: position.coords.longitude
        };

        updateDriverPosition(coords.lat, coords.lon);

        if (showAlert) {
          home = {
            address: 'Minha localização atual',
            lat: coords.lat,
            lon: coords.lon
          };

          localStorage.setItem('flrota.home', JSON.stringify(home));

          if ($('homeDialog')?.open) {
            $('homeDialog').close();
          }

          recalc();
        }

        resolve(coords);
      },
      error => {
        console.error('Erro GPS:', error);
        setMapStatus('Não foi possível obter sua localização.');

        if (showAlert) {
          alert('Não foi possível obter sua localização. Verifique a permissão de localização do navegador.');
        }

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
    position => {
      updateDriverPosition(
        position.coords.latitude,
        position.coords.longitude
      );

      if (navigationActive) maybeRecalculateNavigation();
    },
    error => console.error('GPS tracking:', error),
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 10000
    }
  );
}

function updateDriverPosition(lat, lon) {
  currentPosition = { lat, lon };

  if (!map || !window.L) return;

  const icon = L.divIcon({
    className: '',
    html: '<div class="driver-marker"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  if (!driverMarker) {
    driverMarker = L.marker([lat, lon], {
      icon,
      zIndexOffset: 1000
    }).addTo(map).bindPopup('<b>Você está aqui</b>');
  } else {
    driverMarker.setLatLng([lat, lon]);
  }

  if (navigationActive) {
    map.setView([lat, lon], Math.max(map.getZoom(), 15), {
      animate: true
    });
  }
}

/* =========================================================
   STATUS DO MAPA
========================================================= */

function setMapStatus(message) {
  const element = $('mapStatus');
  if (element) element.textContent = message;
}

/* =========================================================
   MAPA - INICIALIZAÇÃO PROTEGIDA
========================================================= */

function initMap() {
  if (map || mapStarting) return;

  if (!window.L) {
    showMapError('Aguardando carregamento do sistema do mapa...');
    return;
  }

  const mapElement = $('map');

  if (!mapElement) {
    showMapError('Não encontrei a área do mapa no HTML.');
    return;
  }

  mapStarting = true;

  try {
    map = L.map(mapElement, {
      zoomControl: true,
      attributionControl: true
    }).setView([-23.5505, -46.6333], 12);

    const tileLayer = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }
    );

    tileLayer.addTo(map);

    tileLayer.on('tileerror', () => {
      setMapStatus('Falha ao carregar imagens do mapa. Verifique a conexão.');
    });

    tileLayer.on('load', () => {
      if (!parcels.length) {
        setMapStatus('Mapa carregado • adicione endereços para montar sua rota.');
      }
    });

    const locateButton = L.control({
      position: 'topright'
    });

    locateButton.onAdd = function() {
      const button = L.DomUtil.create(
        'button',
        'map-location-control'
      );

      button.type = 'button';
      button.innerHTML = '⌖';
      button.title = 'Minha localização';

      L.DomEvent.disableClickPropagation(button);

      L.DomEvent.on(button, 'click', () => {
        if (currentPosition) {
          map.setView(
            [currentPosition.lat, currentPosition.lon],
            17
          );
        } else {
          getCurrentLocation();
        }
      });

      return button;
    };

    locateButton.addTo(map);

    setMapStatus('Mapa iniciado • aguardando carregamento das imagens.');

    setTimeout(() => {
      map?.invalidateSize();
    }, 500);

    console.log('FL ROTA: mapa iniciado com sucesso.');

  } catch (error) {
    console.error('Erro ao iniciar mapa:', error);
    map = null;
    showMapError('Erro ao iniciar o mapa. Confira a conexão e atualize a página.');
  } finally {
    mapStarting = false;
  }
}

/* =========================================================
   AGUARDAR LEAFLET
========================================================= */

function waitForLeaflet(attempt = 0) {
  if (window.L) {
    initMap();
    return;
  }

  if (attempt >= 20) {
    showMapError('O sistema do mapa não carregou. Verifique a conexão.');
    console.error('Leaflet não foi carregado após várias tentativas.');
    return;
  }

  setTimeout(() => waitForLeaflet(attempt + 1), 500);
}

/* =========================================================
   GEOCODIFICAÇÃO
========================================================= */

async function geocode(address) {
  try {
    const query = address.includes('Brasil')
      ? address
      : address + ', Brasil';

    const url =
      'https://nominatim.openstreetmap.org/search' +
      '?format=jsonv2&limit=1&countrycodes=br&q=' +
      encodeURIComponent(query);

    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error('Erro HTTP ' + response.status);
    }

    const data = await response.json();

    if (!data.length) return null;

    return {
      lat: Number(data[0].lat),
      lon: Number(data[0].lon)
    };

  } catch (error) {
    console.error('Erro ao localizar endereço:', error);
    return null;
  }
}

/* =========================================================
   ROTA PELAS RUAS - OSRM
========================================================= */

async function requestRoute(start, destinations) {
  if (!start || !destinations.length) return null;

  const coordinates = [
    `${start.lon},${start.lat}`,
    ...destinations.map(point => `${point.lon},${point.lat}`)
  ].join(';');

  const url =
    'https://router.project-osrm.org/route/v1/driving/' +
    coordinates +
    '?overview=full&geometries=geojson&steps=true';

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error('OSRM HTTP ' + response.status);
    }

    const data = await response.json();

    if (data.code !== 'Ok' || !data.routes?.length) {
      return null;
    }

    return data.routes[0];

  } catch (error) {
    console.error('Erro ao calcular rota:', error);
    return null;
  }
}

/* =========================================================
   LIMPAR MARCADORES E ROTA
========================================================= */

function clearDeliveryMarkers() {
  deliveryMarkers.forEach(marker => {
    if (map) map.removeLayer(marker);
  });

  deliveryMarkers = [];
}

function clearRoute() {
  if (routeLayer && map) {
    map.removeLayer(routeLayer);
  }

  routeLayer = null;
}

/* =========================================================
   MARCADORES DE ENTREGA
========================================================= */

function drawDeliveryMarkers(order) {
  clearDeliveryMarkers();

  if (!map) return;

  order.forEach((parcel, index) => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="delivery-marker"><span>${index + 1}</span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      popupAnchor: [0, -34]
    });

    const marker = L.marker(
      [Number(parcel.lat), Number(parcel.lon)],
      { icon }
    ).addTo(map);

    marker.bindPopup(`
      <div style="min-width:190px">
        <b>Entrega ${index + 1}</b><br><br>
        ${escapeHtml(parcel.address)}<br><br>
        <span style="color:#666">
          ${escapeHtml(parcel.code || 'Sem código')}
        </span>
      </div>
    `);

    deliveryMarkers.push(marker);
  });
}

/* =========================================================
   DESENHAR ROTA
========================================================= */

function drawRoute(route) {
  clearRoute();

  if (!map || !route?.geometry) return;

  routeLayer = L.geoJSON(route.geometry, {
    style: {
      color: '#FF3038',
      weight: 6,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }
  }).addTo(map);

  const bounds = routeLayer.getBounds();

  if (bounds.isValid()) {
    map.fitBounds(bounds, {
      padding: [30, 30]
    });
  }
}

/* =========================================================
   INFORMAÇÕES DA ROTA
========================================================= */

function updateRouteInfo(route, stops) {
  if (!route) {
    setText('routeDistance', '--');
    setText('routeTime', '--');
    setText('routeStops', stops || 0);
    return;
  }

  const distanceKm = route.distance / 1000;
  const minutes = Math.round(route.duration / 60);

  setText(
    'routeDistance',
    distanceKm < 10
      ? distanceKm.toFixed(1) + ' km'
      : Math.round(distanceKm) + ' km'
  );

  if (minutes < 60) {
    setText('routeTime', minutes + ' min');
  } else {
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;

    setText(
      'routeTime',
      hours + 'h ' + remaining + 'min'
    );
  }

  setText('routeStops', stops || 0);
}

/* =========================================================
   DISTÂNCIA APROXIMADA
========================================================= */

function distance(a, b) {
  const lat =
    ((Number(a.lat) + Number(b.lat)) / 2) *
    Math.PI / 180;

  const x = (Number(a.lat) - Number(b.lat)) * 111.32;

  const y =
    (Number(a.lon) - Number(b.lon)) *
    111.32 *
    Math.cos(lat);

  return Math.sqrt(x * x + y * y);
}

/* =========================================================
   RECALCULAR ROTA
========================================================= */

async function recalc() {
  if (routingBusy) return;

  const pending = parcels.filter(p => !p.done);

  if (!pending.length) {
    window.flrotaOrder = [];
    clearDeliveryMarkers();
    clearRoute();
    updateRouteInfo(null, 0);
    setMapStatus('Adicione endereços para montar sua rota.');
    return;
  }

  routingBusy = true;

  try {
    setMapStatus('Localizando endereços...');

    for (const parcel of pending) {
      const hasCoordinates =
        parcel.lat !== null &&
        parcel.lat !== undefined &&
        parcel.lon !== null &&
        parcel.lon !== undefined &&
        Number.isFinite(Number(parcel.lat)) &&
        Number.isFinite(Number(parcel.lon));

      if (!hasCoordinates) {
        const location = await geocode(parcel.address);

        if (location) {
          parcel.lat = location.lat;
          parcel.lon = location.lon;
        }
      }
    }

    localStorage.setItem(
      'flrota.parcels',
      JSON.stringify(parcels)
    );

    const located = pending.filter(p =>
      p.lat !== null &&
      p.lat !== undefined &&
      p.lon !== null &&
      p.lon !== undefined &&
      Number.isFinite(Number(p.lat)) &&
      Number.isFinite(Number(p.lon))
    );

    if (!located.length) {
      setMapStatus('Nenhum endereço foi localizado. Confira rua, número, cidade e CEP.');
      render();
      return;
    }

    let start = null;

    if (navigationActive && currentPosition) {
      start = { ...currentPosition };

    } else if (
      home?.lat !== null &&
      home?.lat !== undefined &&
      home?.lon !== null &&
      home?.lon !== undefined
    ) {
      start = {
        lat: Number(home.lat),
        lon: Number(home.lon)
      };

    } else if (
      home?.address &&
      home.address !== 'Minha localização atual'
    ) {
      start = await geocode(home.address);
    }

    if (!start && currentPosition) {
      start = { ...currentPosition };
    }

    if (!start) {
      start = await getCurrentLocation();
    }

    if (!start) {
      setMapStatus('Defina o ponto de partida ou permita o GPS.');
      return;
    }

    const remaining = [...located];
    const ordered = [];
    let current = { ...start };

    while (remaining.length) {
      remaining.sort(
        (a, b) => distance(current, a) - distance(current, b)
      );

      const next = remaining.shift();

      ordered.push(next);

      current = {
        lat: Number(next.lat),
        lon: Number(next.lon)
      };
    }

    window.flrotaOrder = ordered;

    drawDeliveryMarkers(ordered);

    setMapStatus('Calculando rota pelas ruas...');

    const route = await requestRoute(start, ordered);

    if (!route) {
      updateRouteInfo(null, ordered.length);

      setMapStatus(
        'Não foi possível calcular a rota. Confira os endereços e tente novamente.'
      );

      return;
    }

    drawRoute(route);
    updateRouteInfo(route, ordered.length);

    setMapStatus(
      navigationActive
        ? 'Navegação ativa • acompanhando sua posição'
        : 'Rota pronta • pressione INICIAR ROTA'
    );

    render();

  } catch (error) {
    console.error('Erro ao recalcular rota:', error);
    setMapStatus('Erro ao montar a rota. Tente novamente.');

  } finally {
    routingBusy = false;
  }
}

/* =========================================================
   NAVEGAÇÃO
========================================================= */

on('navBtn', 'click', async () => {
  if (!navigationActive) {
    const next = window.flrotaOrder?.find(p => !p.done);

    if (!next) {
      alert('Nenhum destino localizado pendente. Primeiro cadastre os pacotes e monte a rota.');
      return;
    }

    navigationActive = true;
    setText('navBtn', '⏹ ENCERRAR NAVEGAÇÃO');

    setMapStatus('Obtendo sua localização...');

    const position = await getCurrentLocation();

    if (!position) {
      navigationActive = false;
      setText('navBtn', 'INICIAR ROTA →');
      return;
    }

    lastRoutePosition = { ...position };

    startLocationTracking();

    if (map) {
      map.setView([position.lat, position.lon], 16);
    }

    await recalc();

    setMapStatus('Navegação ativa • siga a rota vermelha');

  } else {
    stopNavigation();
  }
});

function stopNavigation() {
  navigationActive = false;
  lastRoutePosition = null;

  setText('navBtn', 'INICIAR ROTA →');

  setMapStatus('Navegação encerrada.');
}

/* =========================================================
   RECÁLCULO DURANTE NAVEGAÇÃO
========================================================= */

async function maybeRecalculateNavigation() {
  if (!navigationActive || routingBusy || !currentPosition) {
    return;
  }

  if (!lastRoutePosition) {
    lastRoutePosition = { ...currentPosition };
    return;
  }

  const moved = distance(
    currentPosition,
    lastRoutePosition
  );

  if (moved >= 0.3) {
    lastRoutePosition = { ...currentPosition };
    await recalc();
  }
}

/* =========================================================
   OCR / CÂMERA
========================================================= */

function openLabelCamera() {
  $('ocrFile')?.click();
}

on('ocrBtn', 'click', openLabelCamera);
on('scanBtn', 'click', openLabelCamera);
on('stopBtn', 'click', stopCamera);

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  const cameraWrap = $('cameraWrap');

  if (cameraWrap) {
    cameraWrap.style.display = 'none';
  }
}

on('ocrFile', 'change', async event => {
  const file = event.target.files?.[0];

  if (!file) return;

  setText('ocrStatus', 'Fotografia recebida. Iniciando leitura...');

  try {
    await readLabelOCR(file);

  } catch (error) {
    console.error('Erro no processamento da foto:', error);

    alert(
      'Erro ao processar a fotografia: ' +
      error.message
    );

  } finally {
    event.target.value = '';
  }
});

async function readLabelOCR(file) {
  const status = $('ocrStatus');

  if (ocrBusy) {
    alert('Já existe uma leitura em andamento.');
    return;
  }

  if (!window.Tesseract) {
    setText('ocrStatus', 'Motor OCR não carregado.');

    alert(
      'O leitor de texto não carregou. Verifique sua conexão com a internet.'
    );

    return;
  }

  ocrBusy = true;

  setText('ocrStatus', 'Preparando leitura da etiqueta...');

  try {
    const result = await window.Tesseract.recognize(
      file,
      'por+eng',
      {
        logger: message => {
          if (message.status === 'recognizing text') {
            setText(
              'ocrStatus',
              'Lendo etiqueta... ' +
              Math.round((message.progress || 0) * 100) +
              '%'
            );

          } else if (message.status) {
            setText(
              'ocrStatus',
              'Processando: ' + message.status
            );
          }
        }
      }
    );

    const rawText = result?.data?.text || '';
    const recognizedText = rawText.trim();

    console.log(
      'TEXTO RECONHECIDO PELO OCR:',
      recognizedText
    );

    if (!recognizedText) {
      setText('ocrStatus', 'Nenhum texto encontrado.');

      alert(
        'Não foi possível reconhecer texto nessa fotografia. Tente outra foto.'
      );

      return;
    }

    const parsed = parseLabelText(recognizedText);

    setText(
      'ocrStatus',
      'Leitura concluída. Confira o texto reconhecido.'
    );

    review('', parsed.address || recognizedText);

  } catch (error) {
    console.error('Falha no OCR:', error);

    setText('ocrStatus', 'Falha na leitura da etiqueta.');

    alert(
      'Erro no reconhecimento: ' +
      (error.message || error)
    );

  } finally {
    ocrBusy = false;
  }
}

/* =========================================================
   IDENTIFICAÇÃO DO ENDEREÇO NA ETIQUETA
========================================================= */

function parseLabelText(raw) {
  const lines = raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 2);

  const normalize = line => line
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  const isNoise = line =>
    /RASTREAMENTO|TRACKING|CODIGO DE BARRAS|PEDIDO|ORDER|SHOPEE|SHEIN|TIKTOK|REMETENTE|CNPJ|CPF|TELEFONE|BARCODE|VOLUME|PESO/
      .test(normalize(line));

  const isStreet = line =>
    /\b(RUA|R\.|AVENIDA|AV\.|TRAVESSA|ESTRADA|RODOVIA|ALAMEDA|PRACA|LARGO|VIELA|ROD\.)\b/i
      .test(line);

  const hasCep = line =>
    /\b\d{5}[- ]?\d{3}\b/.test(line);

  const cleanLines = lines.filter(line =>
    !isNoise(line) || isStreet(line) || hasCep(line)
  );

  let selected = [];

  const recipientIndex = cleanLines.findIndex(line =>
    /DESTINATARIO|ENTREGA|SHIP TO|RECEIVER|ENDERECO DE ENTREGA/
      .test(normalize(line))
  );

  if (recipientIndex >= 0) {
    selected = cleanLines.slice(
      recipientIndex + 1,
      recipientIndex + 8
    );
  }

  if (!selected.some(isStreet)) {
    const streetIndex = cleanLines.findIndex(isStreet);

    if (streetIndex >= 0) {
      selected = cleanLines.slice(
        streetIndex,
        streetIndex + 6
      );
    }
  }

  if (!selected.length) {
    const cepIndex = cleanLines.findIndex(hasCep);

    if (cepIndex >= 0) {
      selected = cleanLines.slice(
        Math.max(0, cepIndex - 3),
        Math.min(cleanLines.length, cepIndex + 2)
      );
    }
  }

  selected = selected
    .filter(line => !isNoise(line) || isStreet(line) || hasCep(line))
    .filter(line => line.length > 2);

  selected = [...new Set(selected)];

  return {
    address: selected.length
      ? selected.join(', ')
      : ''
  };
}

/* =========================================================
   PESQUISA MANUAL
========================================================= */

const addressSearch = $('addressSearch');

if (addressSearch) {
  addressSearch.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();

      const address = addressSearch.value.trim();

      if (!address) return;

      review('', address);
      addressSearch.value = '';
    }
  });
}

/* =========================================================
   ATUALIZAR ROTA
========================================================= */

on('routeBtn', 'click', async () => {
  await recalc();
});

/* =========================================================
   INICIALIZAÇÃO DO APLICATIVO
========================================================= */

function initializeApp() {
  console.log('FL ROTA: iniciando aplicativo...');

  render();

  waitForLeaflet();

  startLocationTracking();

  if (parcels.length) {
    setTimeout(() => recalc(), 1000);
  } else {
    setMapStatus('Adicione endereços para montar sua rota.');
  }
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

/* =========================================================
   SERVICE WORKER
========================================================= */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch(error => {
        console.error(
          'Erro no Service Worker:',
          error
        );
      });
  });
}

/* =========================================================
   ERROS GERAIS
========================================================= */

window.addEventListener('error', event => {
  console.error(
    'Erro JavaScript no FL ROTA:',
    event.message,
    event.filename,
    event.lineno
  );
});

console.log('FL ROTA: arquivo app.js carregado.');
