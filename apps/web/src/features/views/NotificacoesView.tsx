import { useCallback, useEffect, useState } from 'react';
import type { Notification } from '@escambo/types';
import { api } from '../../lib/api';
import { dt } from '../../lib/format';

export function NotificacoesView() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    void api
      .notifications()
      .then((n) => {
        setItems(n.items);
        setUnread(n.unreadCount);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => load(), [load]);

  async function readAll() {
    try {
      await api.markAllNotificationsRead();
      load();
    } catch {
      /* ignore */
    }
  }
  async function read(id: number) {
    try {
      await api.markNotificationRead(id);
      load();
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="view">
      <div className="view-head">
        <h2>
          Notificações {unread > 0 && <span className="chip rank">{unread} não lidas</span>}
        </h2>
        {unread > 0 && (
          <button className="dark" onClick={readAll}>
            Marcar todas
          </button>
        )}
      </div>
      <section className="card wide">
        {items.length === 0 ? (
          <p className="muted">Sem notificações.</p>
        ) : (
          <ul className="list">
            {items.map((n) => (
              <li key={n.id} className={n.isRead ? '' : 'unread'} onClick={() => !n.isRead && read(n.id)}>
                <div>
                  <strong>{n.title}</strong>
                  {n.body && <div className="muted">{n.body}</div>}
                  <div className="muted tiny">{dt(n.createdAt)}</div>
                </div>
                {!n.isRead && <span className="dot" />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
