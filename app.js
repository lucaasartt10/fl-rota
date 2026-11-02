const $ = id => document.getElementById(id);

const readStorage = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
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

window.flrotaOrder = [];

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
  localStorage.setItem(
    'flrota.parcels',
    JSON.stringify(parcels)
  );

  render();
  recalc();
}

function render() {
  $('count').textContent = parcels.length;

  $('pending').textContent =
    parcels.filter(p => !p.done).length;

  $('done').textContent =
    parcels.filter(p => p.done).length;

  $('list').innerHTML = parcels.length
    ? parcels.map((p, i) => `
      <div class="parcel">

        <span class="pill">
          ${p.done ? 'Entregue' : 'Pendente'}
        </span>

        <strong>
          ${escapeHtml(p.address)}
        </strong>

        <small>
          ${escapeHtml(p.code || 'Sem código')}
          ·
          ${p.lat && p.lon
            ? 'Localizado'
            : 'Aguardando localização'}
        </small>

        <div style="display:flex;gap:7px;margin-top:9px">

          <button
            class="secondary"
            style="padding:7px 10px;font-size:11px"
            onclick="toggleDone(${i})"
          >
            ${p.done ? 'Reabrir' : 'Marcar entregue'}
          </button>

          <button
            class="danger"
            style="padding:7px 10px;font-size:11px"
            onclick="removeParcel(${i})"
          >
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

  parcels.splice(i, 1);

  save();
};


/* =========================================================
   CONFIRMAÇÃO DE PACOTE
========================================================= */

function review(code, address) {

  pendingCode = code || '';

  $('reviewCode').value = code || '';
  $('reviewAddress').value = address || '';

  const dialog = $('reviewDialog');

  if (!dialog.open) {
    dialog.showModal();
  }

  $('reviewAddress').focus();
}


$('cancelReview').onclick = () => {
  $('reviewDialog').close();
};


$('confirmReview').onclick = () => {

  const code =
    $('reviewCode').value.trim();

  const address =
    $('reviewAddress').value.trim();

  if (!address) {
    alert('Informe o endereço antes de salvar.');
    return;
  }

  if (
    code &&
    parcels.some(p => p.code === code)
  ) {
    alert('Esse código já foi cadastrado.');
    return;
  }

  if (
    parcels.some(
      p =>
        p.address.toLowerCase() ===
        address.toLowerCase() &&
        !p.done
    )
  ) {
    alert(
      'Esse endereço já está cadastrado como pendente.'
    );
    return;
  }

  parcels.push({

    code: code || '',

    address,

    done: false,

    created: Date.now(),

    lat: null,

    lon: null

  });

  $('reviewDialog').close();

  $('code').value = '';
  $('address').value = '';

  save();
};


$('addBtn').onclick = () => {

  review(
    $('code').value.trim(),
    $('address').value.trim()
  );

};


$('manualBtn').onclick = () => {

  $('code').focus();

  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: 'smooth'
  });

};


$('clearBtn').onclick = () => {

  if (
    confirm(
      'Apagar todos os pacotes deste aparelho?'
    )
  ) {

    parcels = [];

    window.flrotaOrder = [];

    save();

  }

};


/* =========================================================
   PONTO DE PARTIDA
========================================================= */

$('homeBtn').onclick = () => {

  $('homeAddress').value =
    home?.address || '';

  $('homeDialog').showModal();

};


$('saveHome').onclick = async () => {

  const address =
    $('homeAddress').value.trim();

  if (!address) {

    alert(
      'Informe o endereço de partida.'
    );

    return;
  }

  home = {

    address,

    lat: home?.lat || null,

    lon: home?.lon || null

  };

  localStorage.setItem(
    'flrota.home',
    JSON.stringify(home)
  );

  $('homeDialog').close();

  await recalc();

};


$('geoBtn').onclick = () => {

  getCurrentLocation(true);

};


/* =========================================================
   GPS
========================================================= */

function getCurrentLocation(showAlert = false) {

  if (!navigator.geolocation) {

    if (showAlert) {
      alert(
        'Geolocalização não disponível neste aparelho.'
      );
    }

    return Promise.resolve(null);
  }

  setMapStatus(
    'Obtendo localização do motorista...'
  );

  return new Promise(resolve => {

    navigator.geolocation.getCurrentPosition(

      position => {

        updateDriverPosition(
          position.coords.latitude,
          position.coords.longitude
        );

        if (showAlert) {

          home = {

            address:
              'Minha localização atual',

            lat:
              position.coords.latitude,

            lon:
              position.coords.longitude

          };

          localStorage.setItem(
            'flrota.home',
            JSON.stringify(home)
          );

          $('homeDialog').close();

          recalc();

        }

        resolve({
          lat:
            position.coords.latitude,

          lon:
            position.coords.longitude
        });

      },

      error => {

        console.error(
          'Erro GPS:',
          error
        );

        setMapStatus(
          'Não foi possível obter sua localização.'
        );

        if (showAlert) {

          alert(
            'Não foi possível obter sua localização. Verifique a permissão de localização do navegador.'
          );

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

    navigator.geolocation.clearWatch(
      locationWatchId
    );

  }

  locationWatchId =
    navigator.geolocation.watchPosition(

      position => {

        updateDriverPosition(
          position.coords.latitude,
          position.coords.longitude
        );

        if (
          navigationActive &&
          currentPosition
        ) {

          maybeRecalculateNavigation();

        }

      },

      error => {

        console.error(
          'GPS tracking:',
          error
        );

      },

      {

        enableHighAccuracy: true,

        maximumAge: 3000,

        timeout: 10000

      }

    );

}


function updateDriverPosition(lat, lon) {

  currentPosition = {
    lat,
    lon
  };

  if (!map) return;

  const icon =
    L.divIcon({

      className: '',

      html:
        '<div class="driver-marker"></div>',

      iconSize: [22, 22],

      iconAnchor: [11, 11]

    });


  if (!driverMarker) {

    driverMarker =
      L.marker(
        [lat, lon],
        {
          icon,
          zIndexOffset: 1000
        }
      )
      .addTo(map)
      .bindPopup(
        '<b>Você está aqui</b>'
      );

  } else {

    driverMarker.setLatLng([
      lat,
      lon
    ]);

  }


  if (navigationActive) {

    map.setView(
      [lat, lon],
      Math.max(map.getZoom(), 15),
      {
        animate: true
      }
    );

  }

}


/* =========================================================
   MAPA
========================================================= */

function initMap() {

  if (!window.L) {

    console.error(
      'Leaflet não carregado.'
    );

    setMapStatus(
      'Erro ao carregar o mapa.'
    );

    return;

  }

  map =
    L.map('map', {

      zoomControl: true,

      attributionControl: true

    }).setView(
      [-23.5505, -46.6333],
      12
    );


  L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,

      attribution:
        '&copy; OpenStreetMap contributors'
    }
  ).addTo(map);


  const locateButton =
    L.control({
      position: 'topright'
    });


  locateButton.onAdd = function() {

    const button =
      L.DomUtil.create(
        'button',
        'map-location-control'
      );

    button.type = 'button';

    button.innerHTML = '⌖';

    button.title =
      'Minha localização';

    L.DomEvent.disableClickPropagation(
      button
    );

    L.DomEvent.on(
      button,
      'click',
      () => {

        if (currentPosition) {

          map.setView(
            [
              currentPosition.lat,
              currentPosition.lon
            ],
            17
          );

        } else {

          getCurrentLocation();

        }

      }
    );

    return button;

  };


  locateButton.addTo(map);


  setTimeout(() => {

    map.invalidateSize();

  }, 300);

}


/* =========================================================
   STATUS DO MAPA
========================================================= */

function setMapStatus(text) {

  const element =
    $('mapStatus');

  if (element) {

    element.textContent = text;

  }

}


/* =========================================================
   GEOCODIFICAÇÃO
========================================================= */

async function geocode(address) {

  try {

    const query =
      address.includes('Brasil')
        ? address
        : address + ', Brasil';


    const url =
      'https://nominatim.openstreetmap.org/search' +
      '?format=jsonv2' +
      '&limit=1' +
      '&countrycodes=br' +
      '&q=' +
      encodeURIComponent(query);


    const response =
      await fetch(url, {

        headers: {

          'Accept':
            'application/json'

        }

      });


    if (!response.ok) {

      throw new Error(
        'Erro HTTP ' +
        response.status
      );

    }


    const data =
      await response.json();


    if (!data.length) {

      return null;

    }


    return {

      lat:
        Number(data[0].lat),

      lon:
        Number(data[0].lon)

    };


  } catch (error) {

    console.error(
      'Erro ao localizar endereço:',
      error
    );

    return null;

  }

}


/* =========================================================
   ROTA PELAS RUAS
