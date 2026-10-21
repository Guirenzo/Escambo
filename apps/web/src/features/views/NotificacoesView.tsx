import { useReadOnlyAccount } from '../../lib/account-access';
import {
  ArrowLeftRight,
  Award,
  Bell,
  CheckCheck,
  ChevronRight,
  Clock,
  FileText,
  LifeBuoy,
  MessageSquare,
  Search,
  ShieldAlert,
  Star,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Notification } from '@escambo/types';
import { Link } from 'react-router-dom';
import { Button, PageHeader, QueryState } from '../../components/ui';
import { dtm } from '../../lib/format';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '../../lib/hooks';
import { notificationPath } from '../../lib/notifications';
import { usePageTitle } from '../../lib/title';

/** Ícone e tom de cada tipo de notificação (pelo começo do nome do tipo); o resto é o sino. */
export function notificationLook(type: string): { Icon: LucideIcon; tone: string } {
  if (/^(dispute|barter_disputed|appeal|content_removed|report|deletion)/.test(type))
    return { Icon: ShieldAlert, tone: 'red' };
  if (/deadline|overdue|reminder|stalled/.test(type)) return { Icon: Clock, tone: 'amber' };
  if (/^(contract|dropout|milestone|delivery)/.test(type)) return { Icon: FileText, tone: 'green' };
  if (/^(message|chat)/.test(type)) return { Icon: MessageSquare, tone: 'blue' };
  if (/^(withdrawal|deposit|payment|wallet|export)/.test(type))
    return { Icon: Wallet, tone: 'green' };
  if (/^review/.test(type)) return { Icon: Star, tone: 'amber' };
  if (/^barter/.test(type)) return { Icon: ArrowLeftRight, tone: 'violet' };
  if (/^saved_search/.test(type)) return { Icon: Search, tone: 'blue' };
  if (/^support/.test(type)) return { Icon: LifeBuoy, tone: 'violet' };
  if (/^(badge|level|mission)/.test(type)) return { Icon: Award, tone: 'amber' };
  return { Icon: Bell, tone: 'neutral' };
}

/** "Hoje", "Ontem", "Últimos 7 dias" ou "Anteriores": o grupo de cada notificação. */
export function notificationGroup(iso: string, now: Date = new Date()): string {
  const start = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(new Date(iso))) / 86_400_000);
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days < 7) return 'Últimos 7 dias';
  return 'Anteriores';
}

export function NotificacoesView() {
  const readOnly = useReadOnlyAccount();
  const notifications = useNotifications();
  const markOne = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const unread = notifications.data?.unreadCount ?? 0;
  // Não lidas na aba do navegador — o mesmo número do badge da navegação.
  usePageTitle(unread > 0 ? `(${unread}) Notificações` : 'Notificações');

  return (
    <div className="page">
      <PageHeader
        title="Notificações"
        subtitle={unread > 0 ? `${unread} não lida${unread > 1 ? 's' : ''}` : 'Tudo em dia.'}
        action={
          unread > 0 ? (
            <Button
              variant="secondary"
              disabled={readOnly || markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <CheckCheck size={16} /> Marcar todas como lidas
            </Button>
          ) : undefined
        }
      />
      <section className="card notif-card">
        <QueryState
          isLoading={notifications.isLoading}
          error={notifications.error}
          data={notifications.data}
          isEmpty={(d) => d.items.length === 0}
          empty="Sem notificações."
          onRetry={() => void notifications.refetch()}
        >
          {(d) => {
            // Em grupos por dia, na ordem em que vieram (a API manda da mais nova para a mais velha).
            const groups: { label: string; items: Notification[] }[] = [];
            for (const n of d.items) {
              const label = notificationGroup(n.createdAt);
              const last = groups.at(-1);
              if (last?.label === label) last.items.push(n);
              else groups.push({ label, items: [n] });
            }
            return groups.map((g) => (
              <div key={g.label} className="notif-group">
                <h2 className="notif-group-title">{g.label}</h2>
                <ul className="list notif-list">
                  {g.items.map((n) => {
                    const { Icon, tone } = notificationLook(n.type);
                    const path = notificationPath(n.data);
                    return (
                      <li
                        key={n.id}
                        className={n.isRead ? '' : 'unread'}
                        onClick={() => !readOnly && !n.isRead && markOne.mutate(n.id)}
                      >
                        <span className={`notif-ico tone-${tone}`} aria-hidden="true">
                          <Icon size={18} />
                        </span>
                        <div className="notif-text">
                          <strong>{n.title}</strong>
                          {n.body && <div className="muted">{n.body}</div>}
                          <div className="muted tiny">{dtm(n.createdAt)}</div>
                        </div>
                        {path && (
                          <Link
                            to={path}
                            className="notif-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!readOnly && !n.isRead) markOne.mutate(n.id);
                            }}
                          >
                            {n.type === 'saved_search_match'
                              ? 'Ver serviços'
                              : n.type === 'content_removed' || n.type === 'appeal_decided'
                                ? 'Ver perfil'
                                : 'Abrir'}
                            <ChevronRight size={14} aria-hidden="true" />
                          </Link>
                        )}
                        {!n.isRead && <span className="dot" role="img" aria-label="não lida" />}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ));
          }}
        </QueryState>
      </section>
    </div>
  );
}
