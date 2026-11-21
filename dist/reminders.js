const pendingLesson = 'coach:open-reminder-lesson';
const legacyPending = 'coach:open-daily-practice';
let lessonRequested = false;

function requestLesson() {
  lessonRequested = true;
  try { sessionStorage.setItem(pendingLesson, '1'); } catch { /* The current tab can still open the lesson. */ }
}

export function watchReminderLinks() {
  const url = new URL(location.href);
  const directLesson = url.searchParams.get('lesson') === 'unstudied';
  const olderReminder = url.searchParams.get('practice') === 'daily';
  if (directLesson || olderReminder) {
    requestLesson();
    if (directLesson) url.searchParams.delete('lesson');
    if (olderReminder) url.searchParams.delete('practice');
    history.replaceState(history.state, '', url.href);
  }
  navigator.serviceWorker?.addEventListener('message', event => {
    if (!['open-reminder-lesson', 'open-daily'].includes(event.data?.type)) return;
    requestLesson();
    window.dispatchEvent(new Event('coach-open-reminder'));
  });
}

export function takeLessonReminder() {
  let requested = lessonRequested;
  try {
    requested = requested || sessionStorage.getItem(pendingLesson) === '1' || sessionStorage.getItem(legacyPending) === '1';
    sessionStorage.removeItem(pendingLesson);
    sessionStorage.removeItem(legacyPending);
  } catch { /* Use the in-memory value when storage is unavailable. */ }
  lessonRequested = false;
  return requested;
}

function timeString(minutes) {
  return [Math.floor(minutes / 60), minutes % 60].map(part => String(part).padStart(2, '0')).join(':');
}

export async function mountReminders(request) {
  const el = id => document.getElementById(id);
  const panel = el('daily-reminder');
  const form = el('reminder-form');
  const input = el('reminder-time');
  const submit = el('reminder-enable');
  const off = el('reminder-disable');
  const test = el('reminder-test');
  const status = el('reminder-status');
  const config = value => request('/api/reminders', value);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let registration;
  let subscription;
  let publicKey;
  let saved;
  let ready = false;
  let busy = false;

  function paint(message) {
    submit.disabled = busy || !ready;
    off.disabled = busy;
    test.disabled = busy;
    submit.textContent = saved ? 'Save time' : 'Enable reminders';
    off.hidden = test.hidden = !saved;
    status.textContent = message ?? (saved ? `On at ${timeString(saved.minute_of_day)} (${saved.time_zone}).` : 'Choose when Coach should remind you on this device.');
  }

  async function perform(action) {
    if (busy) return;
    busy = true;
    paint();
    let message;
    try { message = await action(); }
    catch (error) {
      message = Notification.permission === 'denied' ? 'Allow Coach notifications in your device settings and reopen the app.' : error.message;
    } finally {
      busy = false;
      paint(message);
    }
  }

  panel.hidden = false;
  if (!('PushManager' in window && 'Notification' in window && navigator.serviceWorker)) {
    paint('Open Coach from your phone’s Home Screen, or use a browser that supports push notifications.');
    return;
  }
  try {
    const [worker, keys] = await Promise.all([navigator.serviceWorker.ready, config({ action: 'key' })]);
    registration = worker;
    const base64 = keys.publicKey.replace(/-/g, '+').replace(/_/g, '/');
    publicKey = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0));
    subscription = await registration.pushManager.getSubscription();
    if (subscription) ({ saved } = await config({ action: 'status', endpoint: subscription.endpoint }));
    if (saved) input.value = timeString(saved.minute_of_day);
    ready = true;
    paint();
  } catch (error) {
    paint(error.message);
    return;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    perform(async () => {
      const [hour, minute] = input.value.split(':').map(Number);
      const minuteOfDay = hour * 60 + minute;
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      await config({ action: 'save', endpoint: subscription.endpoint, subscription: subscription.toJSON(), timeZone, minute: minuteOfDay });
      saved = { minute_of_day: minuteOfDay, time_zone: timeZone };
    });
  });
  off.addEventListener('click', () => perform(async () => {
    await config({ action: 'disable', endpoint: subscription.endpoint });
    saved = null;
    await subscription.unsubscribe();
    subscription = null;
    return 'Reminders are off on this device.';
  }));
  test.addEventListener('click', () => perform(async () => {
    await config({ action: 'test', endpoint: subscription.endpoint });
    return 'Test notification sent.';
  }));
}
