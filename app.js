
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
  $('count').textContent = parcels.length;
  $('pending').textContent = parcels.filter(p => !p.done).length;
  $('done').textContent = parcels.filter(p => p.done).length;

  $('list').innerHTML = parcels.length
    ? parcels.map((p, i) => `
      <div class="parcel">
        <span class="pill">${p.done ? 'Entregue' : 'Pendente'}</span>
        <strong>${escapeHtml(p.address)}</strong>
        <small>${escapeHtml(p.code || 'Sem código')} · ${p.lat ? 'Localizado' : 'Aguardando localização'}</small>
        <div style="display:flex;gap:7px;margin-top:9px">
          <button class="secondary" style="padding:7px 10px;font-size:11px"
            onclick="toggleDone(${i})">${p.done ? 'Reabrir' : 'Marcar entregue'}</button>
          <button class="danger" style="padding:7px 10px;font-size:11px"
            onclick="removeParcel(${i})">Excluir</button>
        </div>
      </div>
    `).join('')
    : '<div class="muted">Nenhum pacote cadastrado ainda.</div>';
}

window.toggleDone = i => {
  parcels[i].done = !parcels[i].done;
  save();
};

window.removeParcel = i => {
  parcels.splice(i, 1);
  save();
};

function review(code, address) {
  pendingCode = code || '';
  $('reviewCode').value = code || '';
  $('reviewAddress').value = address || '';
  $('reviewDialog').showModal();
}

$('cancelReview').onclick = () => $('reviewDialog').close();

$('confirmReview').onclick = () => {
  const code = $('reviewCode').value.trim();
  const address = $('reviewAddress').value.trim();

  if (!address) {
    alert('Não encontrei um endereço. Confira e informe o endereço antes de salvar.');
    return;
  }

  if (code && parcels.some(p => p.code === code)) {
    alert('Esse código já foi cadastrado.');
    return;
  }

  if (parcels.some(p =>
    p.address.toLowerCase() === address.toLowerCase() && !p.done
  )) {
    alert('Esse endereço já está cadastrado como pendente.');
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
  review($('code').value.trim(), $('address').value.trim());
};

$('manualBtn').onclick = () => {
  $('code').focus();
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
};

$('clearBtn').onclick = () => {
  if (confirm('Apagar todos os pacotes deste aparelho?')) {
    parcels = [];
    save();
  }
};

$('homeBtn').onclick = () => {
  $('homeAddress').value = home?.address || '';
  $('homeDialog').showModal();
};

$('saveHome').onclick = async () => {
  const address = $('homeAddress').value.trim();

  if (!address) {
    alert('Informe o endereço de partida.');
    return;
  }

  home = {
    address,
    lat: home?.lat || null,
    lon: home?.lon || null
  };

  localStorage.setItem('flrota.home', JSON.stringify(home));
  $('homeDialog').close();
  recalc();
};

$('geoBtn').onclick = () => {
  if (!navigator.geolocation) {
    alert('Geolocalização não disponível.');
    return;
  }

  navigator.geolocation.getCurrentPosition(pos => {
    home = {
      address: 'Minha localização atual',
      lat: pos.coords.latitude,
      lon: pos.coords.longitude
    };

    localStorage.setItem('flrota.home', JSON.stringify(home));
    $('homeDialog').close();
    recalc();
  }, () => {
    alert('Não foi possível obter a localização. Verifique a permissão do navegador.');
  }, {
    enableHighAccuracy: true,
    timeout: 12000
  });
};

/* FOTOGRAFIA E LEITURA DA ETIQUETA */

function openLabelCamera() {
  $('ocrFile').click();
}

$('ocrBtn').onclick = openLabelCamera;
$('scanBtn').onclick = openLabelCamera;

$('stopBtn').onclick = () => {
  stopCamera();
};

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  $('cameraWrap').style.display = 'none';
}

$('ocrFile').onchange = async event => {
  const file = event.target.files?.[0];
  if (!file) return;

  await readLabelOCR(file);
  event.target.value = '';
};

async function readLabelOCR(file) {
  const status = $('ocrStatus');

  if (ocrBusy) return;

  if (!window.Tesseract) {
    alert('O leitor de texto não carregou. Verifique sua conexão com a internet.');
    return;
  }

  ocrBusy = true;
  status.textContent = 'Preparando leitura da etiqueta...';

  try {
    const result = await Tesseract.recognize(file, 'por+eng', {
      logger: message => {
        if (message.status === 'recognizing text') {
          status.textContent =
            'Lendo endereço... ' +
            Math.round((message.progress || 0) * 100) + '%';
        }
      }
    });

    const rawText = result.data.text || '';
    const parsed = parseLabelText(rawText);

    if (!parsed.address) {
      status.textContent = 'Não encontrei um endereço com segurança.';
      alert(
        'Não consegui identificar o endereço. Tente fotografar a etiqueta inteira, de frente e com boa iluminação.'
      );
      return;
    }

    status.textContent = 'Endereço identificado. Confira antes de salvar.';
    review('', parsed.address);

  } catch (error) {
    console.error(error);
    status.textContent = 'Falha na leitura da etiqueta.';
    alert('Não consegui ler a imagem. Tente novamente com uma foto mais nítida.');
  } finally {
    ocrBusy = false;
  }
}

/* IDENTIFICAÇÃO DO ENDEREÇO */

function parseLabelText(raw) {
  const lines = raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 2);

  const normalized = lines.map(line =>
    line.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
  );

  const isNoise = line =>
    /RASTREAMENTO|TRACKING|CODIGO|PEDIDO|ORDER|SHOPEE|SHEIN|TIKTOK|REMETENTE|CNPJ|CPF|TELEFONE|BARCODE|VOLUME|PESO/.test(line);

  const isRecipient = line =>
    /DESTINATARIO|DESTINATARIO|ENTREGA|SHIP TO|RECEIVER/.test(line);

  const isStreet = line =>
    /\b(RUA|R\.|AVENIDA|AV\.|TRAVESSA|ESTRADA|RODOVIA|ALAMEDA|PRACA|PRACA|LARGO)\b/i.test(line);

  const cepIndex = normalized.findIndex(line =>
    /\b\d{5}[- ]?\d{3}\b/.test(line)
  );

  let selected = [];
  const recipientIndex = normalized.findIndex(isRecipient);

  if (recipientIndex >= 0) {
    for (
      let i = recipientIndex + 1;
      i < Math.min(lines.length, recipientIndex + 9);
      i++
    ) {
      if (isNoise(normalized[i]) && !isStreet(lines[i])) continue;
      selected.push(lines[i]);

      if (selected.length >= 6) break;
    }
  }

  if (!selected.some(isStreet)) {
    const streetIndex = lines.findIndex(isStreet);

    if (streetIndex >= 0) {
      selected = lines.slice(streetIndex, streetIndex + 5)
        .filter((line, index) =>
          !isNoise(normalized[streetIndex + index]) ||
          isStreet(line)
        );
    }
  }

  if (!selected.some(line => /\d{5}[- ]?\d{3}/.test(line)) && cepIndex >= 0) {
    selected.push(lines[cepIndex]);
  }

  selected = selected.filter(line =>
    !isNoise(line.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()) ||
    isStreet(line)
  );

  selected = [...new Set(selected)];

  let address = selected.join(', ');

  // Evita usar a etiqueta inteira como se fosse um endereço.
  if (!address || (!selected.some(isStreet) && cepIndex < 0)) {
    address = '';
  }

  return { address };
}

/* PESQUISA MANUAL DE ENDEREÇO */

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

/* LOCALIZAÇÃO E ORGANIZAÇÃO DA ROTA */

async function geocode(address) {
  try {
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
      encodeURIComponent(address);

    const response = await fetch(url);
    const data = await response.json();

    return data[0]
      ? { lat: Number(data[0].lat), lon: Number(data[0].lon) }
      : null;
  } catch (error) {
    console.error('Erro ao localizar endereço:', error);
    return null;
  }
}

async function recalc() {
  const pending = parcels.filter(p => !p.done);

  if (!pending.length) {
    $('map').textContent = 'Adicione endereços para montar sua rota.';
    window.flrotaOrder = [];
    return;
  }

  $('map').textContent = 'Localizando endereços...';

  for (const parcel of pending) {
    if (!parcel.lat || !parcel.lon) {
      const location = await geocode(parcel.address);

      if (location) {
        parcel.lat = location.lat;
        parcel.lon = location.lon;
      }
    }
  }

  localStorage.setItem('flrota.parcels', JSON.stringify(parcels));

  const located = pending.filter(p => p.lat && p.lon);

  if (!located.length) {
    $('map').textContent =
      'Não foi possível localizar os endereços. Confira rua, número, cidade e CEP.';
    render();
    return;
  }

  let start = home?.lat
    ? { lat: home.lat, lon: home.lon }
    : null;

  if (!start && home?.address) {
    start = await geocode(home.address);
  }

  if (!start && navigator.geolocation) {
    start = await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        position => resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude
        }),
        () => resolve(null),
        { timeout: 5000 }
      );
    });
  }

  if (start) {
    const remaining = [...located];
    const ordered = [];
    let current = start;

    while (remaining.length) {
      remaining.sort((a, b) => distance(current, a) - distance(current, b));
      const next = remaining.shift();
      ordered.push(next);
      current = next;
    }

    window.flrotaOrder = ordered;
  } else {
    window.flrotaOrder = located;
  }

  $('map').innerHTML = `
    <div style="padding:15px;text-align:left">
      <b>${located.length} de ${pending.length} endereços localizados</b>
      <p class="muted">
        Ordem aproximada por proximidade. A otimização por ruas e trânsito será uma próxima etapa.
      </p>
      <ol>
        ${window.flrotaOrder.map(parcel =>
          `<li>${escapeHtml(parcel.address)}</li>`
        ).join('')}
      </ol>
    </div>
  `;

  render();
}

function distance(a, b) {
  return Math.hypot(
    (a.lat - b.lat) * Math.cos(a.lat * Math.PI / 180),
    a.lon - b.lon
  );
}

$('routeBtn').onclick = recalc;

$('navBtn').onclick = () => {
  const next = (window.flrotaOrder || []).find(p => !p.done);

  if (!next) {
    alert('Nenhum destino localizado pendente.');
    return;
  }

  const url =
    'https://www.google.com/maps/dir/?api=1&destination=' +
    encodeURIComponent(next.address) +
    '&travelmode=driving';

  window.open(url, '_blank');
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

render();
