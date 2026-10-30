import React, { useState, useEffect, useRef } from 'react';
import {
  Bell,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Clock,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '../../services/api.ts';
import { AdminNotificationItem, AuthUser } from '../../../shared/types.ts';

interface AdminNotificationsDropdownProps {
  currentUser: AuthUser;
  onNavigate?: (tab: string) => void;
}

export const AdminNotificationsDropdown: React.FC<AdminNotificationsDropdownProps> = ({
  currentUser,
  onNavigate,
}) => {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isAdminRole = ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN'].includes(currentUser.role);

  const fetchNotifications = async () => {
    if (!isAdminRole) return;
    setIsLoading(true);
    setError(null);
    try {
      if (currentUser.isPreview) {
        // Deterministic simulation notifications in preview mode
        const today = new Date().toISOString().split('T')[0];
        setNotifications([
          {
            id: `emp-01_INCOMPLETE_PUNCH_${today}`,
            companyId: 'preview-co',
            type: 'INCOMPLETE_PUNCH',
            severity: 'WARN',
            title: 'Missing Check-Out Punch',
            message: 'Jane Employee (EMP-001) checked in today but has not punched out yet.',
            employeeId: 'emp-01',
            employeeName: 'Jane Employee',
            employeeCode: 'EMP-001',
            workDate: today,
            actionUrl: '/attendance',
            createdAt: new Date().toISOString(),
          },
          {
            id: `emp-02_NO_SHIFT_ASSIGNED_${today}`,
            companyId: 'preview-co',
            type: 'NO_SHIFT_ASSIGNED',
            severity: 'WARN',
            title: 'Unassigned Working Schedule',
            message: 'Robert Fox (EMP-002) has no assigned shift. Working hours are unavailable.',
            employeeId: 'emp-02',
            employeeName: 'Robert Fox',
            employeeCode: 'EMP-002',
            workDate: today,
            actionUrl: '/employees',
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }

      const res = await api.getAdminNotifications();
      setNotifications(res.items || []);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setError(apiErr.message || 'Failed to load notifications.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAdminRole) {
      fetchNotifications();
    }
  }, [currentUser]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  if (!isAdminRole) {
    return null;
  }

  const getNotificationIcon = (type: string, severity: string) => {
    if (severity === 'ERROR') return <AlertCircle className="w-4 h-4 text-rose-400" />;
    switch (type) {
      case 'HOURS_COMPLETED':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'SHORT_HOURS':
        return <Clock className="w-4 h-4 text-amber-400" />;
      case 'INCOMPLETE_PUNCH':
        return <AlertTriangle className="w-4 h-4 text-rose-400" />;
      case 'NO_SHIFT_ASSIGNED':
        return <HelpCircle className="w-4 h-4 text-amber-400" />;
      default:
        return <AlertCircle className="w-4 h-4 text-indigo-400" />;
    }
  };

  const handleActionClick = (actionUrl: string) => {
    setIsOpen(false);
    if (!onNavigate) return;
    if (actionUrl.includes('attendance')) {
      onNavigate('attendance');
    } else if (actionUrl.includes('employees')) {
      onNavigate('employees');
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) fetchNotifications();
        }}
        className="relative p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-colors cursor-pointer border border-transparent hover:border-slate-800"
        title="Admin Notifications"
        aria-label="Admin Notifications"
      >
        <Bell className="w-4 h-4" />
        {notifications.length > 0 && (
          <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-slate-950 ring-2 ring-slate-900">
            {notifications.length > 9 ? '9+' : notifications.length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 overflow-hidden animate-fadeIn">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-950/70">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                Shift &amp; Attendance Alerts
              </span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                {notifications.length}
              </span>
            </div>
            <button
              onClick={fetchNotifications}
              disabled={isLoading}
              className="text-slate-400 hover:text-slate-200 transition-colors p-1 rounded hover:bg-slate-800"
              title="Refresh alerts"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto divide-y divide-slate-800/60">
            {isLoading && notifications.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">Loading alerts...</div>
            ) : error ? (
              <div className="p-4 text-xs text-rose-300 bg-rose-950/20">{error}</div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400 space-y-1">
                <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto" />
                <div className="font-semibold text-slate-300">All shifts and punches aligned</div>
                <div className="text-[11px] text-slate-500">No pending attendance alerts found.</div>
              </div>
            ) : (
              notifications.map((item) => (
                <div
                  key={item.id}
                  className="p-3.5 hover:bg-slate-800/40 transition-colors flex items-start gap-3"
                >
                  <div className="mt-0.5 flex-shrink-0">{getNotificationIcon(item.type, item.severity)}</div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-200 truncate">{item.title}</span>
                      <span className="text-[10px] font-mono text-slate-500 flex-shrink-0">{item.workDate}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-snug">{item.message}</p>
                    <button
                      onClick={() => handleActionClick(item.actionUrl)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 transition-colors mt-1"
                    >
                      <span>Review in Module</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 bg-slate-950/80 border-t border-slate-800 text-[11px] text-slate-500 text-center">
            Authoritative, tenant-isolated attendance diagnostics
          </div>
        </div>
      )}
    </div>
  );
};
