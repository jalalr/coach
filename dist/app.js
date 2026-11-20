import { connectAccount } from './account.js';
import { coachApiBase } from './host-config.js';

const $ = id => document.getElementById(id);
const storageKey = 'success-mastery:teachability:pilot-v1';
let lesson;
let results = [];
let showingFeedback = false;
let account;
let authSession;
let progressVersion = 0;
let saving = false;

function authHeaders() {
  return authSession ? { Authorization: `Bearer ${authSession.access_token}` } : {};
}

async function request(path, body) {
  const options = { headers: authHeaders() };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(coachApiBase + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not finish. Try again.');
  return data;
}

let playback;

function stopPlayback() {
  const current = playback;
  if (!current) return;
  playback = undefined;
  current.controller.abort();
  current.audio?.pause();
  if (current.url) URL.revokeObjectURL(current.url);
  current.control.textContent = current.label;
  current.status.textContent = '';
}

async function readAloud(id, control, status) {
  const wasPlaying = playback?.control === control;
  stopPlayback();
  status.textContent = '';
  if (wasPlaying) return;
  cancelVoice();
  $('source-audio').pause();
  const current = { control, status, label: control.textContent, controller: new AbortController() };
  playback = current;
  control.textContent = 'Cancel read-aloud';
  status.textContent = 'Preparing audio…';
  try {
    const response = await fetch(coachApiBase + '/api/speech', {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      signal: current.controller.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const blob = await response.blob();
    if (playback !== current) return;
    current.url = URL.createObjectURL(blob);
    current.audio = new Audio(current.url);
    current.audio.addEventListener('ended', () => { if (playback === current) stopPlayback(); });
    await current.audio.play();
    if (playback === current) {
      control.textContent = 'Stop reading';
      status.textContent = '';
    }
  } catch (error) {
    if (playback !== current) return;
    stopPlayback();
    status.textContent = error.message || 'Audio could not play. Try again.';
  }
}

async function ask() {
  const input = $('question');
  const question = input.value.trim();
  const submit = $('ask-form').querySelector('button');
  if (!question || submit.disabled) return;
  if (playback?.control === $('read-reply')) stopPlayback();
  submit.disabled = true;
  $('answer').hidden = false;
  $('read-reply').hidden = true;
  $('read-status').textContent = '';
  $('reply').textContent = 'Finding a lesson response…';
  try {
    const { reply, speechId } = await request('/api/coach', { question });
    $('reply').textContent = reply;
    $('read-reply').dataset.speechId = speechId;
    $('read-reply').hidden = false;
  } catch (error) {
    $('reply').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

$('ask-form').addEventListener('submit', event => { event.preventDefault(); ask(); });
$('read-reply').addEventListener('click', () => {
  const control = $('read-reply');
  readAloud(control.dataset.speechId, control, $('read-status'));
});

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, action, style = 'primary') {
  const element = node('button', label, style);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

async function loadProgress() {
  const { choices, version } = await account.progress();
  if (version <= progressVersion) return false;
  const restored = await Promise.all(choices.map(async (choice, index) => {
    const question = lesson.questions[index];
    const outcome = await request('/api/grade', { id: question.id, choice });
    return { id: question.id, choice, ...outcome };
  }));
  if (version <= progressVersion) return false;
  results = restored;
  progressVersion = version;
  showingFeedback = false;
  return true;
}

async function saveQuiz(nextResults) {
  if (account) {
    const version = await account.save(nextResults.map(result => result.choice), progressVersion);
    if (version === null) {
      await loadProgress();
      renderQuiz();
      $('quiz-status').textContent = 'Progress changed on another device. The latest quiz is shown here.';
      return false;
    }
    progressVersion = version;
  }
  results = nextResults;
  if (account) return true;
  try {
    localStorage.setItem(storageKey, JSON.stringify(results));
  } catch {
    return null;
  }
  return true;
}

function renderQuiz() {
  const body = $('quiz-body');
  if (playback && body.contains(playback.control)) stopPlayback();
  const total = lesson.questions.length;
  const question = lesson.questions[showingFeedback ? results.length - 1 : results.length];
  $('quiz-progress').max = total;
  $('quiz-progress').value = results.length;
  $('quiz-status').textContent = '';
  body.replaceChildren();
  if (!question) {
    $('quiz-position').textContent = 'Complete';
    const score = results.filter(result => result.correct).length;
    const retry = button('Try again', async () => {
      if (saving) return;
      saving = true;
      retry.disabled = true;
      try {
        if (await saveQuiz([]) === false) return;
        renderQuiz();
        $('quiz-body').querySelector('input')?.focus();
      } catch (error) {
        $('quiz-status').textContent = error.message;
      } finally {
        saving = false;
        retry.disabled = false;
      }
    });
    body.append(node('p', `${score} / ${total}`, 'result'), node('p', 'You finished the Teachability quiz.', 'result-copy'), retry);
    return;
  }
  $('quiz-position').textContent = `${showingFeedback ? results.length : results.length + 1} of ${total}`;
  if (showingFeedback) {
    const { correct, feedback } = results.at(-1);
    const next = button(results.length === total ? 'See result' : 'Next question', () => {
      showingFeedback = false;
      renderQuiz();
      $('quiz-body').querySelector('input,button')?.focus();
    });
    const message = node('p', `${correct ? 'Correct.' : 'Good try.'} ${feedback}`, 'feedback');
    message.setAttribute('role', 'status');
    const readFeedback = button('Read feedback aloud', () => readAloud(`feedback:${question.id}`, readFeedback, $('quiz-status')), 'link');
    const actions = node('div', '', 'voice-controls');
    actions.append(next, readFeedback);
    body.append(message, actions);
    next.focus();
    return;
  }

  const form = node('form');
  const fieldset = node('fieldset');
  const legend = node('legend', question.prompt);
  fieldset.append(legend);
  for (const choice of question.choices) {
    const label = node('label', '', 'choice');
    const input = node('input');
    Object.assign(input, { type: 'radio', name: 'choice', value: choice.id, required: true });
    label.append(input, node('span', `${choice.id.toUpperCase()}. ${choice.text}`));
    fieldset.append(label);
  }
  const submit = node('button', 'Check answer', 'primary');
  const tools = node('div', '', 'voice-controls');
  const read = button('Read question aloud', () => readAloud(`question:${question.id}`, read, $('quiz-status')), 'link');
  const say = button('Say A, B, or C', () => toggleVoice('quiz'), 'link');
  say.id = 'quiz-voice';
  say.hidden = !voiceReady;
  tools.append(read, say);
  form.append(fieldset, submit, tools);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || saving) return;
    saving = true;
    submit.disabled = true;
    try {
      const choice = new FormData(form).get('choice');
      const outcome = await request('/api/grade', { id: question.id, choice });
      cancelVoice();
      const saved = await saveQuiz([...results, { id: question.id, choice, ...outcome }]);
      if (saved === false) return;
      showingFeedback = true;
      renderQuiz();
      if (saved === null) $('quiz-status').textContent = 'This browser could not keep your result after closing the page.';
    } catch (error) {
      $('quiz-status').textContent = error.message;
    } finally {
      saving = false;
      submit.disabled = false;
    }
  });
  body.append(form);
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const locale = { langs: ['en-US'], processLocally: true };
let voiceReady = false;
let session;

function paintVoice(message = '', mode = 'coach') {
  const listening = session && !session.released;
  const coachListening = listening && session.mode === 'coach';
  $('hold').disabled = !voiceReady;
  $('hold').dataset.recording = Boolean(coachListening);
  $('hold-label').textContent = coachListening ? 'Listening… release to send' : 'Hold to talk';
  $('toggle-record').hidden = !voiceReady;
  $('toggle-record').textContent = coachListening ? 'Stop and send' : 'Start recording';
  const quizButton = $('quiz-voice');
  if (quizButton) {
    quizButton.hidden = !voiceReady;
    quizButton.textContent = listening && session.mode === 'quiz' ? 'Stop and select' : 'Say A, B, or C';
  }
  $(mode === 'quiz' ? 'quiz-status' : 'voice-status').textContent = message;
}

async function configureVoice(install = false) {
  if (!Recognition?.available || !Recognition.install || !('processLocally' in Recognition.prototype)) {
    paintVoice('Use Chrome with on-device speech recognition, or type your question below.');
    return;
  }
  $('setup').disabled = true;
  try {
    const availability = await Recognition.available(locale);
    voiceReady = availability === 'available';
    if (!voiceReady && install && ['downloadable', 'downloading'].includes(availability)) {
      paintVoice('Downloading the local English speech pack…');
      voiceReady = await Recognition.install(locale);
    }
    $('setup').hidden = voiceReady || availability === 'unavailable';
    const message = voiceReady ? 'Hold with mouse, touch, or Space. Release to ask.' : availability === 'unavailable'
      ? 'Local English speech is unavailable in this browser. You can type below.' : 'Enable voice to install the local English speech pack.';
    paintVoice(message);
  } catch {
    $('setup').hidden = false;
    paintVoice('Local speech setup could not finish. Try enabling voice again or type below.');
  } finally {
    $('setup').disabled = false;
  }
}

function beginVoice(mode, input) {
  if (!voiceReady || session) return;
  stopPlayback();
  $('source-audio').pause();
  const recognition = new Recognition();
  recognition.lang = locale.langs[0];
  recognition.processLocally = true;
  recognition.interimResults = false;
  recognition.continuous = true;
  const current = { mode, input, recognition, text: '', released: false, started: false };
  session = current;
  function fail(message) {
    if (session !== current) return;
    clearTimeout(current.timeout);
    session = undefined;
    paintVoice(message, mode);
  }
  recognition.onstart = () => {
    if (session !== current) return;
    current.started = true;
    if (current.released) recognition.stop();
    else paintVoice('Listening…', mode);
  };
  recognition.onresult = event => {
    current.text = Array.from(event.results, result => result[0].transcript).join(' ').trim();
  };
  recognition.onerror = event => fail(event.error === 'not-allowed' || event.error === 'service-not-allowed'
    ? 'Allow microphone access in Chrome and try again.' : `Voice recognition ended (${event.error}). Try again.`);
  recognition.onend = () => {
    if (session !== current) return;
    clearTimeout(current.timeout);
    session = undefined;
    if (!current.text) return paintVoice('No speech captured. Try holding a little longer.', mode);
    if (mode === 'coach') {
      $('question').value = current.text.slice(0, 350);
      paintVoice('Question transcribed on this device.', mode);
      ask();
      return;
    }
    const spoken = current.text.toLowerCase().replace(/[^a-z ]/g, '').trim();
    const choice = /^(?:option |choice |answer )?(a|b|c)$/.exec(spoken)?.[1] ?? { ay: 'a', bee: 'b', be: 'b', see: 'c', sea: 'c' }[spoken];
    const radio = choice && $('quiz-body').querySelector(`input[value="${choice}"]`);
    if (radio) {
      radio.checked = true;
      paintVoice(`Selected ${choice.toUpperCase()}. Review it, then choose Check answer.`, mode);
    } else paintVoice(`Heard “${current.text}”. Say A, B, or C, or select an option.`, mode);
  };
  try {
    recognition.start();
    current.timeout = setTimeout(() => { if (session === current) finishVoice(); }, 25000);
    paintVoice('Opening microphone…', mode);
  } catch { fail('The microphone could not open. Try again.'); }
}

function finishVoice() {
  if (!session || session.released) return;
  session.released = true;
  const current = session;
  clearTimeout(current.timeout);
  current.timeout = setTimeout(() => {
    if (session !== current) return;
    cancelVoice();
    paintVoice('Speech recognition timed out. Try again or type your question.', current.mode);
  }, 10000);
  if (session.started) session.recognition.stop();
  paintVoice('Recognising speech…', session.mode);
}

function cancelVoice() {
  if (!session) return;
  const { recognition, mode, timeout } = session;
  session = undefined;
  clearTimeout(timeout);
  recognition.abort();
  paintVoice('Recording cancelled.', mode);
}

function toggleVoice(mode) {
  if (!session) beginVoice(mode, 'toggle');
  else if (session.mode === mode) finishVoice();
}

$('setup').addEventListener('click', () => configureVoice(true));
$('toggle-record').addEventListener('click', () => toggleVoice('coach'));
$('hold').addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  $('hold').setPointerCapture(event.pointerId);
  beginVoice('coach', event.pointerId);
});
$('hold').addEventListener('pointerup', event => { if (session?.input === event.pointerId) finishVoice(); });
for (const type of ['pointercancel', 'lostpointercapture']) {
  $('hold').addEventListener(type, event => { if (session?.input === event.pointerId && !session.released) cancelVoice(); });
}
$('hold').addEventListener('keydown', event => {
  if (event.code !== 'Space') return;
  event.preventDefault();
  if (!event.repeat) beginVoice('coach', 'space');
});
document.addEventListener('keyup', event => { if (event.code === 'Space' && session?.input === 'space') finishVoice(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelVoice(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelVoice(); });
window.addEventListener('blur', () => { if (session?.started && !session.released) cancelVoice(); });

const audio = $('source-audio');
$('source-play').addEventListener('click', async () => {
  if (!lesson) return;
  if (!audio.paused) { audio.pause(); return; }
  stopPlayback();
  $('source-play').disabled = true;
  try {
    if (!audio.src && account) {
      const response = await fetch('/source-audio', { headers: authHeaders() });
      if (!response.ok) throw new Error('Could not load the recording.');
      audio.src = URL.createObjectURL(await response.blob());
    } else if (!audio.src) audio.src = '/source-audio';
    audio.currentTime = lesson.citation.playbackStart ?? lesson.citation.start;
    await audio.play();
  } catch { $('citation').textContent = 'The recording could not play. Try again.'; }
  finally { $('source-play').disabled = false; }
});
audio.addEventListener('play', () => { $('source-play').textContent = 'Pause excerpt'; });
audio.addEventListener('pause', () => { $('source-play').textContent = 'Play excerpt'; });
audio.addEventListener('timeupdate', () => { if (audio.currentTime >= (lesson.citation.playbackEnd ?? lesson.citation.end)) audio.pause(); });

async function loadCourse() {
  $('source-play').disabled = true;
  lesson = await request('/api/lesson');
  const time = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('summary').textContent = lesson.summary;
  $('exercise').textContent = lesson.exercise;
  $('citation').textContent = `${lesson.citation.title} · ${time(lesson.citation.start)}–${time(lesson.citation.end)}`;
  $('source-play').hidden = !lesson.recordingAvailable;
  $('source-play').disabled = false;
  if (account) await loadProgress();
  else {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (Array.isArray(saved) && saved.every((item, index) => item?.id === lesson.questions[index]?.id && typeof item.correct === 'boolean' && typeof item.feedback === 'string')) results = saved;
    } catch { /* A new quiz can still be taken. */ }
  }
  renderQuiz();
  $('workspace').hidden = false;
  $('course-view').hidden = false;
  $('sign-in').hidden = true;
  configureVoice();
}

function showLoadError(error) {
  $('load-error').hidden = false;
  $('load-error').textContent = error.message;
}

async function signedIn() {
  $('sign-out').hidden = false;
  await loadCourse();
}

let pendingEmail;
async function accountAction(event, action) {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button');
  submit.disabled = true;
  $('account-status').textContent = '';
  try { await action(); }
  catch (error) { $('account-status').textContent = error.message; }
  finally { submit.disabled = false; }
}

$('send-code').addEventListener('submit', event => accountAction(event, async () => {
  const email = $('email').value.trim();
  await request('/api/sign-in-email', { email });
  pendingEmail = email;
  $('verify-code').hidden = false;
  $('account-status').textContent = 'Enter the code from your email. If you received a link instead, copy it from the email and paste it here.';
  $('code').focus();
}));
$('verify-code').addEventListener('submit', event => accountAction(event, async () => {
  authSession = await account.verify(pendingEmail, $('code').value.trim());
  $('code').value = '';
  await signedIn();
}));
$('sign-out').addEventListener('click', async () => {
  try { await account.signOut(); location.reload(); }
  catch (error) { showLoadError(error); }
});

window.addEventListener('focus', async () => {
  if (!account || !lesson || !authSession || saving || showingFeedback || $('course-view').hidden) return;
  try { if (await loadProgress()) renderQuiz(); }
  catch (error) { $('quiz-status').textContent = error.message; }
});

try {
  const config = await request('/api/config');
  if (config.account) {
    account = await connectAccount(config.account);
    $('pilot-label').textContent = 'Private pilot';
    authSession = await account.session();
    account.watch((event, updated) => {
      if (event === 'TOKEN_REFRESHED') authSession = updated;
      if (event === 'SIGNED_OUT' && authSession) location.reload();
    });
    if (authSession) await signedIn();
    else $('sign-in').hidden = false;
  } else await loadCourse();
} catch (error) {
  showLoadError(error);
}
