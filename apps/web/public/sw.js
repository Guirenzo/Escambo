/* Service worker do Escambo (ADR 52): só os avisos push. Nada de cache offline por enquanto. */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Escambo', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Escambo';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      tag: payload.tag || 'escambo',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      lang: 'pt-BR',
      data: { url: payload.url || '/notificacoes' },
    }),
  );
});

/* Tocar no aviso traz a aba que já está aberta; se não houver, abre uma na tela certa. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/notificacoes', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      const open = clients.find((client) => 'focus' in client);
      if (!open) return self.clients.openWindow(url);
      /* Focar sempre funciona; navegar pode ser recusado, e aí vale abrir uma aba nova. */
      return open
        .focus()
        .then((client) => (client && 'navigate' in client ? client.navigate(url) : null))
        .catch(() => null)
        .then((client) => client || self.clients.openWindow(url));
    }),
  );
});
