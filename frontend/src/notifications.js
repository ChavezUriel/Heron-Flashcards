// Daily review-reminder notifications (browser Notification API).
//
// Scope: notifications can only fire while the app is open in a tab — true
// push while the site is closed needs a service worker + push server. The
// once-per-day guard lives in localStorage so reopening the app does not spam.

const REMINDER_SETTINGS_KEY = 'heron.reminderSettings';
const LAST_NOTIFIED_KEY = 'heron.lastDueNotificationDate';

export const DEFAULT_REMINDER_SETTINGS = {
  enabled: false,
};

export function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function loadReminderSettings() {
  if (typeof window === 'undefined') {
    return DEFAULT_REMINDER_SETTINGS;
  }

  const rawValue = window.localStorage.getItem(REMINDER_SETTINGS_KEY);
  if (!rawValue) {
    return DEFAULT_REMINDER_SETTINGS;
  }

  try {
    return { ...DEFAULT_REMINDER_SETTINGS, ...JSON.parse(rawValue) };
  } catch {
    return DEFAULT_REMINDER_SETTINGS;
  }
}

export function saveReminderSettings(settings) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify(settings));
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) {
    return 'unsupported';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Fire at most one due-cards notification per calendar day.
export function maybeNotifyDueCards(dueSummary) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  const settings = loadReminderSettings();
  if (!settings.enabled) {
    return false;
  }

  const dueNow = dueSummary?.due_now ?? 0;
  if (dueNow <= 0) {
    return false;
  }

  if (window.localStorage.getItem(LAST_NOTIFIED_KEY) === todayKey()) {
    return false;
  }

  window.localStorage.setItem(LAST_NOTIFIED_KEY, todayKey());

  const cardsLabel = dueNow === 1 ? '1 card is' : `${dueNow} cards are`;
  try {
    const notification = new Notification('Heron — time to review', {
      body: `${cardsLabel} due for review. A short session now keeps them in memory.`,
      tag: 'heron-due-reminder',
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
