import { Bell, CheckCheck } from 'lucide-react';
import { Button, PageHeader, QueryState } from '../../components/ui';
import { dtm } from '../../lib/format';
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications } from '../../lib/hooks';

export function NotificacoesView() {
  const notifications = useNotifications();
  const markOne = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const unread = notifications.data?.unreadCount ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Notificações"
        subtitle={unread > 0 ? `${unread} não lida${unread > 1 ? 's' : ''}` : 'Tudo em dia.'}
        action={
          unread > 0 ? (
            <Button variant="secondary" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
              <CheckCheck size={16} /> Marcar todas como lidas
            </Button>
          ) : undefined
        }
      />
      <section className="card">
        <QueryState
          isLoading={notifications.isLoading}
          error={notifications.error}
          data={notifications.data}
          isEmpty={(d) => d.items.length === 0}
          empty="Sem notificações."
          onRetry={() => void notifications.refetch()}
        >
          {(d) => (
            <ul className="list">
              {d.items.map((n) => (
                <li key={n.id} className={n.isRead ? '' : 'unread'} onClick={() => !n.isRead && markOne.mutate(n.id)}>
                  <div className="rank-left">
                    <span className="kpi-ico">
                      <Bell size={16} />
                    </span>
                    <div>
                      <strong>{n.title}</strong>
                      {n.body && <div className="muted">{n.body}</div>}
                      <div className="muted tiny">{dtm(n.createdAt)}</div>
                    </div>
                  </div>
                  {!n.isRead && <span className="dot" />}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
