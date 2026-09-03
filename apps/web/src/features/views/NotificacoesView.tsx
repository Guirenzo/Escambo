import { Button, PageHeader, QueryState } from '../../components/ui';
import { dt } from '../../lib/format';
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications } from '../../lib/hooks';

export function NotificacoesView() {
  const notifications = useNotifications();
  const markOne = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const unread = notifications.data?.unreadCount ?? 0;

  return (
    <div className="view">
      <PageHeader
        title={
          <>
            Notificações {unread > 0 && <span className="chip rank">{unread} não lidas</span>}
          </>
        }
        action={
          unread > 0 ? (
            <Button variant="dark" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
              Marcar todas
            </Button>
          ) : undefined
        }
      />
      <section className="card wide">
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
        </QueryState>
      </section>
    </div>
  );
}
