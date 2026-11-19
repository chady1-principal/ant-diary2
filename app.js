const STORAGE_KEYS = {
  SETTINGS: 'voice_diary_settings_v1',
  ENTRIES: 'voice_diary_entries_v1',
  DRAFT: 'voice_diary_draft_v1',
  THEME: 'voice_diary_theme_v1',
};

const state = {
  settings: {
    appsScriptUrl: '',
    geminiApiKey: '',
    speechLang: 'ko-KR',
  },
  entries: [],
  searchQuery: '',
  isRecording: false,
  recognition: null,
};

let previousContentForUndo = '';

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 4500);
}

function formatTodayDefaults() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  $('entryDate').value = `${yyyy}-${mm}-${dd}`;
  $('entryTime').value = `${hh}:${min}`;

  const weekday = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()];
  $('todayLabel').textContent = `${yyyy}.${mm}.${dd} (${weekday})`;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
    state.settings = { ...state.settings, ...saved };
  } catch (_) {
    // ignore corrupted storage
  }
  $('appsScriptUrlInput').value = state.settings.appsScriptUrl || '';
  $('geminiApiKeyInput').value = state.settings.geminiApiKey || '';
  $('speechLangSelect').value = state.settings.speechLang || 'ko-KR';
  updateSyncBadge();
}

function saveSettings() {
  state.settings.appsScriptUrl = $('appsScriptUrlInput').value.trim();
  state.settings.geminiApiKey = $('geminiApiKeyInput').value.trim();
  state.settings.speechLang = $('speechLangSelect').value;
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
  updateSyncBadge();
  showToast('설정이 저장되었습니다.');
}

function updateSyncBadge() {
  const pill = $('syncStatusPill');
  const text = $('syncStatusText');
  if (state.settings.appsScriptUrl) {
    pill.classList.add('connected');
    text.textContent = '시트 연동됨';
    $('saveEntryBtn').textContent = '구글 시트에 일기 저장하기';
  } else {
    pill.classList.remove('connected');
    text.textContent = '로컬 모드';
    $('saveEntryBtn').textContent = '기기에 일기 저장하기';
  }
}

function loadTheme() {
  const saved = localStorage.getItem(STORAGE_KEYS.THEME);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(STORAGE_KEYS.THEME, next);
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach((el) => {
    el.classList.toggle('active', el.id === `panel-${tabName}`);
  });
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });
  if (tabName === 'list') {
    fetchEntries();
  }
}

// ---------------- 자동 GPS 날씨 (Open-Meteo) ----------------
function weatherCodeToKorean(code) {
  if (code === 0) return '☀️ 맑음';
  if (code === 1 || code === 2) return '⛅ 구름 조금';
  if (code === 3) return '☁️ 흐림';
  if (code === 45 || code === 48) return '🌫️ 안개';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '🌧️ 비';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '❄️ 눈';
  if (code >= 95) return '⛈️ 천둥번개';
  return '🌤️ 보통';
}

function fetchAutoWeather(showSuccessToast = false) {
  const input = $('entryWeather');
  if (!navigator.geolocation) {
    input.placeholder = '날씨를 직접 입력하세요 (예: 맑음)';
    if (showSuccessToast) showToast('이 브라우저는 위치 기능을 지원하지 않습니다.');
    return;
  }

  input.placeholder = '현재 위치 날씨 확인 중...';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=Asia%2FSeoul`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('날씨 조회 실패');
        const data = await res.json();
        const current = data.current || {};
        const label = weatherCodeToKorean(current.weather_code);
        const temp = typeof current.temperature_2m === 'number'
          ? ` ${Math.round(current.temperature_2m)}°C`
          : '';
        input.value = `${label}${temp}`;
        saveDraft();
        if (showSuccessToast) showToast(`현재 날씨를 불러왔습니다: ${input.value}`);
      } catch (_) {
        input.placeholder = '날씨를 직접 입력하세요 (예: 맑음)';
        if (showSuccessToast) showToast('날씨를 불러오지 못해 직접 입력이 필요합니다.');
      }
    },
    () => {
      input.placeholder = '날씨를 직접 입력하세요 (예: 맑음)';
      if (showSuccessToast) showToast('위치 권한이 꺼져 있어 날씨를 직접 입력해주세요.');
    },
    { timeout: 8000, maximumAge: 600000 }
  );
}

// ---------------- 음성 인식 (Web Speech API) ----------------
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = state.settings.speechLang || 'ko-KR';

  recognition.onresult = (event) => {
    let interim = '';
    let finalChunk = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalChunk += transcript;
      } else {
        interim += transcript;
      }
    }

    if (finalChunk) {
      const textarea = $('entryContent');
      const existing = textarea.value;
      const spacer = existing && !existing.endsWith(' ') && !existing.endsWith('\n') ? ' ' : '';
      textarea.value = existing + spacer + finalChunk.trim();
      saveDraft();
    }

    if (interim) {
      $('interimBox').classList.remove('hidden');
      $('interimText').textContent = interim;
    } else {
      $('interimBox').classList.add('hidden');
      $('interimText').textContent = '';
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      stopRecording();
      showToast('마이크 권한을 허용해주세요.');
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      showToast(`음성 인식 오류: ${event.error}`);
    }
  };

  recognition.onend = () => {
    if (state.isRecording) {
      try {
        recognition.start();
      } catch (_) {
        stopRecording();
      }
    }
  };

  return recognition;
}

function startRecording() {
  if (!state.recognition) {
    state.recognition = initSpeechRecognition();
  }
  if (!state.recognition) {
    showToast('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Safari를 이용해주세요.');
    return;
  }

  state.recognition.lang = state.settings.speechLang || 'ko-KR';
  state.isRecording = true;
  $('micBtn').classList.add('recording');
  $('micIcon').textContent = '⏹️';
  $('voiceStateTitle').textContent = '듣고 있어요... (누르면 중지)';
  $('voiceStateHint').textContent = '편하게 말씀하시면 자동으로 문장이 입력됩니다';

  try {
    state.recognition.start();
  } catch (_) {
    // already started
  }
}

function stopRecording() {
  state.isRecording = false;
  $('micBtn').classList.remove('recording');
  $('micIcon').textContent = '🎤';
  $('voiceStateTitle').textContent = '마이크를 눌러 말해보세요';
  $('voiceStateHint').textContent = '한국어 음성 인식이 실시간으로 텍스트로 변환됩니다';
  $('interimBox').classList.add('hidden');
  $('interimText').textContent = '';

  if (state.recognition) {
    try {
      state.recognition.stop();
    } catch (_) {
      // ignore
    }
  }
}

function toggleRecording() {
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

// ---------------- 임시 저장 ----------------
function saveDraft() {
  const draft = {
    content: $('entryContent').value,
    weather: $('entryWeather').value,
  };
  localStorage.setItem(STORAGE_KEYS.DRAFT, JSON.stringify(draft));
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(STORAGE_KEYS.DRAFT) || '{}');
    if (draft.content) $('entryContent').value = draft.content;
    if (draft.weather) $('entryWeather').value = draft.weather;
  } catch (_) {
    // ignore
  }
}

// ---------------- 맞춤법 검사 ----------------
function localSpellCheck(text) {
  let fixed = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,.!?])([^\s\n])/g, '$1 $2')
    .replace(/할수\s*있/g, '할 수 있')
    .replace(/할수\s*없/g, '할 수 없')
    .replace(/수있/g, '수 있')
    .replace(/수없/g, '수 없')
    .replace(/안되/g, '안 돼')
    .replace(/되요/g, '돼요')
    .replace(/됬/g, '됐')
    .replace(/어떻해/g, '어떡해')
    .replace(/몇일/g, '며칠')
    .replace(/금새/g, '금세')
    .replace(/일기장\s*을/g, '일기장을')
    .trim();

  if (fixed && !/[.!?。]$/.test(fixed)) {
    fixed += '.';
  }
  return fixed;
}

async function spellCheckWithGemini(text, apiKey) {
  const prompt = [
    '다음 한국어 음성 인식 일기 문장의 맞춤법, 띄어쓰기, 문장부호, 그리고 음성 인식으로 잘못 들린 어색한 단어를 자연스럽게 교정해주세요.',
    '원래 말투와 의미는 그대로 유지하고, 교정된 본문 텍스트만 출력하세요.',
    `원문:\n${text}`,
  ].join('\n\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini API 오류 (${res.status})`);
  }

  const data = await res.json();
  const corrected = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!corrected) throw new Error('교정 결과를 받지 못했습니다.');
  return corrected;
}

async function handleSpellCheck() {
  const textarea = $('entryContent');
  const text = textarea.value.trim();
  if (!text) {
    showToast('먼저 맞춤법을 검사할 일기 내용을 입력해주세요.');
    return;
  }

  const btn = $('spellCheckBtn');
  btn.disabled = true;
  previousContentForUndo = textarea.value;

  try {
    if (state.settings.geminiApiKey) {
      textarea.value = await spellCheckWithGemini(text, state.settings.geminiApiKey);
      showToast('AI 맞춤법·문장 교정이 완료되었습니다.');
    } else {
      textarea.value = localSpellCheck(text);
      showToast('기본 맞춤법·띄어쓰기를 정리했습니다.');
    }
    $('undoSpellBtn').classList.remove('hidden');
    saveDraft();
  } catch (err) {
    textarea.value = localSpellCheck(text);
    $('undoSpellBtn').classList.remove('hidden');
    showToast(`AI 교정 실패로 기본 맞춤법 정리를 적용했습니다: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function undoSpellCheck() {
  if (!previousContentForUndo) return;
  $('entryContent').value = previousContentForUndo;
  previousContentForUndo = '';
  $('undoSpellBtn').classList.add('hidden');
  saveDraft();
  showToast('원래 글로 되돌렸습니다.');
}

// ---------------- 구글 시트 & 로컬 저장/조회 ----------------
function getLocalEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.ENTRIES) || '[]');
  } catch (_) {
    return [];
  }
}

function saveLocalEntries(entries) {
  localStorage.setItem(STORAGE_KEYS.ENTRIES, JSON.stringify(entries));
}

async function handleSaveEntry() {
  const content = $('entryContent').value.trim();
  if (!content) {
    showToast('일기 본문을 입력해주세요.');
    return;
  }

  if (state.isRecording) {
    stopRecording();
  }

  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    date: $('entryDate').value,
    time: $('entryTime').value,
    weather: $('entryWeather').value.trim(),
    content,
    createdAt: new Date().toISOString(),
  };

  const btn = $('saveEntryBtn');
  btn.disabled = true;
  btn.textContent = '저장하는 중...';
  const sheetUrl = state.settings.appsScriptUrl || $('appsScriptUrlInput').value.trim();

  try {
    if (sheetUrl) {
      if (!state.settings.appsScriptUrl) {
        state.settings.appsScriptUrl = sheetUrl;
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
      }
      const res = await fetch(sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'create', ...entry }),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || '시트 저장 실패');
      }
      showToast('구글 시트에 일기가 저장되었습니다!');
    } else {
      const local = getLocalEntries();
      local.unshift(entry);
      saveLocalEntries(local);
      showToast('기기에 일기가 저장되었습니다. (설정에서 웹 앱 URL을 저장하세요)');
    }

    $('entryContent').value = '';
    previousContentForUndo = '';
    $('undoSpellBtn').classList.add('hidden');
    formatTodayDefaults();
    localStorage.removeItem(STORAGE_KEYS.DRAFT);
  } catch (err) {
    const local = getLocalEntries();
    local.unshift(entry);
    saveLocalEntries(local);
    showToast(`시트 전송 실패(로컬에 임시 저장됨): ${err.message}`);
  } finally {
    btn.disabled = false;
    updateSyncBadge();
  }
}

async function fetchEntries() {
  const container = $('entriesContainer');
  container.innerHTML = '<div class="empty-state">일기를 불러오는 중...</div>';

  try {
    if (state.settings.appsScriptUrl) {
      const url = new URL(state.settings.appsScriptUrl);
      url.searchParams.set('action', 'list');
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || '목록 불러오기 실패');
      }
      state.entries = data.entries || [];
      saveLocalEntries(state.entries);
    } else {
      state.entries = getLocalEntries();
    }
  } catch (err) {
    state.entries = getLocalEntries();
    showToast(`시트 불러오기 실패(로컬 캐시 표시): ${err.message}`);
  }

  renderEntries();
}

function renderEntries() {
  const container = $('entriesContainer');
  const q = state.searchQuery.trim().toLowerCase();

  const filtered = state.entries.filter((item) => {
    if (!q) return true;
    const hay = [item.date, item.time, item.weather, item.mood, item.content]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">표시할 일기가 없습니다.<br/>첫 번째 음성 일기를 기록해보세요!</div>';
    return;
  }

  container.innerHTML = '';
  for (const item of filtered) {
    const card = document.createElement('article');
    card.className = 'entry-card';

    const header = document.createElement('div');
    header.className = 'entry-header';

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    meta.textContent = `${item.date || ''} ${item.time || ''}`.trim();

    header.appendChild(meta);

    const badgeText = item.weather || item.mood || '';
    if (badgeText) {
      const badge = document.createElement('span');
      badge.className = 'entry-mood';
      badge.textContent = badgeText;
      header.appendChild(badge);
    }

    card.appendChild(header);

    const content = document.createElement('p');
    content.className = 'entry-content';
    content.textContent = item.content;
    card.appendChild(content);

    container.appendChild(card);
  }
}

async function testConnection() {
  const rawUrl = $('appsScriptUrlInput').value.trim();
  if (!rawUrl) {
    showToast('먼저 Apps Script 웹 앱 URL을 입력해주세요.');
    return;
  }

  try {
    const url = new URL(rawUrl);
    url.searchParams.set('action', 'ping');
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '응답 오류');
    state.settings.appsScriptUrl = rawUrl;
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
    updateSyncBadge();
    showToast(`연결 성공 및 자동 저장됨! (${data.spreadsheetName} / 기록 ${data.count}건)`);
  } catch (err) {
    showToast(`연결 실패: ${err.message}`);
  }
}

function exportJsonBackup() {
  const data = getLocalEntries();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `voice-diary-backup-${$('entryDate').value || 'export'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- 초기화 ----------------
function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('syncStatusPill').addEventListener('click', () => switchTab('settings'));
  $('micBtn').addEventListener('click', toggleRecording);
  $('refreshWeatherBtn').addEventListener('click', () => fetchAutoWeather(true));
  $('spellCheckBtn').addEventListener('click', handleSpellCheck);
  $('undoSpellBtn').addEventListener('click', undoSpellCheck);
  $('saveEntryBtn').addEventListener('click', handleSaveEntry);

  $('clearContentBtn').addEventListener('click', () => {
    $('entryContent').value = '';
    previousContentForUndo = '';
    $('undoSpellBtn').classList.add('hidden');
    saveDraft();
  });

  ['entryContent', 'entryWeather'].forEach((id) => {
    $(id).addEventListener('input', saveDraft);
  });

  $('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderEntries();
  });

  $('refreshListBtn').addEventListener('click', fetchEntries);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('testConnectionBtn').addEventListener('click', testConnection);
  $('toggleThemeBtn').addEventListener('click', toggleTheme);
  $('exportJsonBtn').addEventListener('click', exportJsonBackup);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // ignore on unsupported environments
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadTheme();
  formatTodayDefaults();
  loadSettings();
  loadDraft();
  bindEvents();
  registerServiceWorker();
  if (!$('entryWeather').value) {
    fetchAutoWeather(false);
  }
});
