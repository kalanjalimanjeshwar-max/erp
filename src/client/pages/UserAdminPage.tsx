import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  UserPlus,
  Shield,
  Search,
  CheckCircle2,
  XCircle,
  KeyRound,
  AlertTriangle,
  RefreshCw,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { previewStore } from '../services/previewStore.ts';
import { UserListItem, AuthUser, Role, EmployeeItem } from '../../shared/types.ts';

interface UserAdminPageProps {
  currentUser: AuthUser;
  initialOpenCreate?: boolean;
  onSwitchPreviewUser?: (user: AuthUser) => void;
}

const ROLES: Role[] = ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE'];

export const UserAdminPage: React.FC<UserAdminPageProps> = ({
  currentUser,
  initialOpenCreate = false,
  onSwitchPreviewUser,
}) => {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Search & Filter
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');

  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(initialOpenCreate);
  const [resetPasswordUserId, setResetPasswordUserId] = useState<string | null>(null);

  // Form states for Create User
  const [newEmail, setNewEmail] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newConfirmPassword, setNewConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [newRole, setNewRole] = useState<Role>('EMPLOYEE');
  const [newIsActive, setNewIsActive] = useState<boolean>(true);
  const [newEmployeeId, setNewEmployeeId] = useState<string>('');
  const [companyEmployees, setCompanyEmployees] = useState<EmployeeItem[]>([]);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(false);
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Form state for Reset Password
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [isSubmittingReset, setIsSubmittingReset] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // Fetch company employees for optional linking
  const fetchEmployees = useCallback(async () => {
    setIsLoadingEmployees(true);
    try {
      const res = await api.getEmployees({ limit: 100 });
      setCompanyEmployees(res.items || []);
    } catch {
      // Graceful fallback if employee endpoint is restricted or unavailable
      setCompanyEmployees([]);
    } finally {
      setIsLoadingEmployees(false);
    }
  }, []);

  useEffect(() => {
    if (initialOpenCreate) {
      setIsCreateModalOpen(true);
    }
  }, [initialOpenCreate]);

  useEffect(() => {
    if (isCreateModalOpen) {
      fetchEmployees();
    }
  }, [isCreateModalOpen, fetchEmployees]);

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    // In Preview Mode, use in-memory demo store while PostgreSQL is offline
    if (currentUser.isPreview) {
      const demoUsers = previewStore.getPreviewUsers({
        search: search.trim() || undefined,
        role: roleFilter || undefined,
      });
      setUsers(demoUsers);
      setIsLoading(false);
      return;
    }

    try {
      const data = await api.listUsers({
        search: search.trim() || undefined,
        role: roleFilter || undefined,
      });
      setUsers(data);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load company user directory.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser.isPreview, search, roleFilter]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);

    // Validation
    if (!newFullName.trim()) {
      setCreateError('Full name is required.');
      return;
    }

    if (!newEmail.trim()) {
      setCreateError('Work email or username is required.');
      return;
    }

    if (newPassword.length < 8) {
      setCreateError('Password must be at least 8 characters long.');
      return;
    }

    if (newPassword !== newConfirmPassword) {
      setCreateError('Passwords do not match. Please re-enter.');
      return;
    }

    // Role ceiling verification
    if (currentUser.role === 'ADMIN' && newRole === 'SUPER_ADMIN') {
      setCreateError('Admins cannot assign the Super Admin role.');
      return;
    }

    // In Preview Mode: Create in-memory demo user only. Do NOT call real user creation API.
    if (currentUser.isPreview) {
      setIsSubmittingCreate(true);
      try {
        const demoUser = previewStore.createPreviewUser({
          email: newEmail.trim(),
          fullName: newFullName.trim(),
          role: newRole,
          isActive: newIsActive,
          employeeId: newEmployeeId.trim() || undefined,
        });

        setSuccessMessage(
          `Preview Demo Account for "${demoUser.fullName}" (${demoUser.role}) created in memory for UI testing. (Preview Only — Not Saved; Lost on Refresh)`
        );
        setIsCreateModalOpen(false);
        setNewEmail('');
        setNewFullName('');
        setNewPassword('');
        setNewConfirmPassword('');
        setNewRole('EMPLOYEE');
        setNewIsActive(true);
        setNewEmployeeId('');
        fetchUsers();
      } catch (err: unknown) {
        setCreateError(err instanceof Error ? err.message : 'Failed to create preview demo user.');
      } finally {
        setIsSubmittingCreate(false);
      }
      return;
    }

    setIsSubmittingCreate(true);

    try {
      await api.createUser({
        email: newEmail.trim(),
        fullName: newFullName.trim(),
        password: newPassword,
        role: newRole,
        isActive: newIsActive,
        employeeId: newEmployeeId.trim() || undefined,
      });

      setSuccessMessage(`User account for "${newEmail.trim()}" (${newRole}) created successfully.`);
      setIsCreateModalOpen(false);
      setNewEmail('');
      setNewFullName('');
      setNewPassword('');
      setNewConfirmPassword('');
      setNewRole('EMPLOYEE');
      setNewIsActive(true);
      setNewEmployeeId('');
      fetchUsers();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setCreateError(err.message);
      } else {
        setCreateError('Failed to create user account.');
      }
    } finally {
      setIsSubmittingCreate(false);
    }
  };

  const handleRoleChange = async (userId: string, updatedRole: Role) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    // In Preview Mode, update in-memory role for UI exploration
    if (currentUser.isPreview) {
      previewStore.updatePreviewUserRole(userId, updatedRole);
      setSuccessMessage(`User role updated to "${updatedRole}" in memory. (Preview Mode — changes not persisted)`);
      fetchUsers();
      return;
    }

    try {
      await api.updateUserRole(userId, updatedRole);
      setSuccessMessage('User role updated successfully.');
      fetchUsers();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to update role.');
      }
    }
  };

  const handleToggleStatus = async (userId: string, currentStatus: boolean) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    // In Preview Mode, toggle status in memory for UI exploration
    if (currentUser.isPreview) {
      previewStore.updatePreviewUserStatus(userId, !currentStatus);
      setSuccessMessage(`User ${!currentStatus ? 'activated' : 'deactivated'} in memory. (Preview Mode — changes not persisted)`);
      fetchUsers();
      return;
    }

    try {
      await api.updateUserStatus(userId, !currentStatus);
      setSuccessMessage(`User ${!currentStatus ? 'activated' : 'deactivated'} successfully.`);
      fetchUsers();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to change user status.');
      }
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPasswordUserId) return;

    setResetError(null);

    // In Preview Mode, simulate password reset for UI exploration
    if (currentUser.isPreview) {
      setSuccessMessage('Password reset tested in memory. (Preview Mode — no real credentials modified)');
      setResetPasswordUserId(null);
      setResetPasswordValue('');
      return;
    }

    setIsSubmittingReset(true);
    try {
      await api.resetUserPassword(resetPasswordUserId, resetPasswordValue);
      setSuccessMessage('Password reset successfully.');
      setResetPasswordUserId(null);
      setResetPasswordValue('');
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setResetError(err.message);
      } else {
        setResetError('Failed to reset password.');
      }
    } finally {
      setIsSubmittingReset(false);
    }
  };

  // Determine which roles current user is allowed to assign
  const allowedAssignableRoles = ROLES.filter((r) => {
    if (currentUser.role === 'SUPER_ADMIN') return true;
    if (currentUser.role === 'ADMIN') return r !== 'SUPER_ADMIN';
    return false;
  });

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Users className="w-6 h-6 text-indigo-400" />
            Company User Administration
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Manage authorized staff accounts, role permissions, active status, and credential resets
          </p>
        </div>

        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md transition cursor-pointer shrink-0"
        >
          <UserPlus className="w-4 h-4" />
          <span>Add New User</span>
        </button>
      </div>

      {/* Explicit Preview Mode Notice */}
      {currentUser.isPreview && (
        <div className="bg-gradient-to-r from-amber-950/70 via-slate-900 to-slate-900 border border-amber-700/80 rounded-xl p-4 text-xs text-amber-200 shadow-lg space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-amber-100 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              Preview Only — Not Saved; Lost on Refresh
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-amber-950 text-amber-300 border border-amber-800 font-semibold">
              In-Memory UI Testing Mode
            </span>
          </div>
          <p className="text-[11px] text-slate-300 leading-relaxed">
            PostgreSQL is offline in the AI Studio preview sandbox. You can safely add and test staff users here in temporary browser memory.
            These demo users are never sent to the backend user creation API or saved to persistent storage. Passwords are not stored.
          </p>
        </div>
      )}

      {/* Notifications */}
      {errorMessage && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-red-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="bg-emerald-950/60 border border-emerald-800/60 rounded-xl p-3.5 text-xs text-emerald-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-emerald-400 hover:text-emerald-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users by name or email..."
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as Role | '')}
          className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
        >
          <option value="">All Roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        <button
          onClick={fetchUsers}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* User Directory Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                <th className="px-5 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Account Status</th>
                <th className="px-4 py-3">Last Active</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-slate-400">
                    {isLoading ? 'Loading staff records...' : 'No users match the search filter.'}
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isSelf = u.id === currentUser.id;
                  const canEditThisUser =
                    currentUser.role === 'SUPER_ADMIN' ||
                    (currentUser.role === 'ADMIN' && u.role !== 'SUPER_ADMIN');

                  return (
                    <tr key={u.id} className="hover:bg-slate-800/40 transition">
                      {/* Name & Email */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-indigo-400">
                            {u.fullName.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                              <span>{u.fullName}</span>
                              {isSelf && (
                                <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-950 text-indigo-300 border border-indigo-800/50">
                                  You
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400">{u.email}</div>
                            {Boolean(u.isPreviewUser || currentUser.isPreview) && (
                              <div className="mt-1">
                                <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-mono bg-amber-950/80 text-amber-300 border border-amber-800/60 font-semibold">
                                  Preview Demo • In-Memory Only
                                </span>
                              </div>
                            )}
                            {u.employee && (
                              <div className="text-[10px] text-violet-400 font-mono mt-0.5">
                                Linked Employee: {u.employee.fullName || u.employee.employeeCode} ({u.employee.employeeCode})
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Role Selector */}
                      <td className="px-4 py-3.5">
                        {canEditThisUser && !isSelf ? (
                          <select
                            value={u.role}
                            onChange={(e) => handleRoleChange(u.id, e.target.value as Role)}
                            className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                          >
                            {allowedAssignableRoles.map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-slate-800 text-indigo-300 border border-slate-700">
                            <Shield className="w-3 h-3" />
                            {u.role}
                          </span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3.5">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            u.isActive
                              ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'
                              : 'bg-red-950/60 text-red-300 border border-red-800/50'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${u.isActive ? 'bg-emerald-400' : 'bg-red-400'}`} />
                          {u.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>

                      {/* Last Active */}
                      <td className="px-4 py-3.5 text-[11px] text-slate-400 font-mono">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never logged in'}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3.5 text-right space-x-2">
                        {currentUser.isPreview && onSwitchPreviewUser && !isSelf && (
                          <button
                            onClick={() => onSwitchPreviewUser(previewStore.createMockAuthUser(u))}
                            className="px-2.5 py-1 bg-indigo-950/90 hover:bg-indigo-900 text-indigo-300 rounded text-[11px] font-medium transition cursor-pointer border border-indigo-800/60"
                            title="Explore Dashboard navigation as this role in preview mode"
                          >
                            Explore as {u.role}
                          </button>
                        )}

                        {canEditThisUser && !isSelf && (
                          <button
                            onClick={() => handleToggleStatus(u.id, u.isActive)}
                            className={`px-2.5 py-1 rounded text-[11px] font-medium transition cursor-pointer border ${
                              u.isActive
                                ? 'bg-red-950/40 hover:bg-red-900/60 text-red-300 border-red-800/40'
                                : 'bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border-emerald-800/40'
                            }`}
                            title={u.isActive ? 'Deactivate user' : 'Reactivate user'}
                          >
                            {u.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        )}

                        {canEditThisUser && (
                          <button
                            onClick={() => setResetPasswordUserId(u.id)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-medium transition cursor-pointer border border-slate-700"
                            title="Reset user password"
                          >
                            <KeyRound className="w-3.5 h-3.5 inline mr-1" />
                            Reset Pass
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal 1: Create User */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-indigo-400" />
                Add New Staff User
              </h3>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {currentUser.isPreview && (
              <div className="bg-amber-950/60 border border-amber-700/70 rounded-xl p-3 text-xs text-amber-200 space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-amber-100">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Preview Only — Not Saved; Lost on Refresh</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Creating temporary in-memory demo account for UI exploration. Passwords are not stored and no data is sent to backend APIs.
                </p>
              </div>
            )}

            {createError && (
              <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3 text-xs text-red-200">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateUser} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Full Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  placeholder="e.g. Eleanor Vance"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Work Email / Username <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="user@yourcompany.com or username"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Used as the shared login identifier across all roles.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Initial Password <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    aria-label={showNewPassword ? 'Hide initial password' : 'Show initial password'}
                    title={showNewPassword ? 'Hide initial password' : 'Show initial password'}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-200 transition cursor-pointer"
                  >
                    {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Confirm Password <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={newConfirmPassword}
                    onChange={(e) => setNewConfirmPassword(e.target.value)}
                    placeholder="Re-enter password to confirm"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                    title={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-200 transition cursor-pointer"
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Role Assignment <span className="text-red-400">*</span>
                </label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Role)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
                >
                  {allowedAssignableRoles.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                {currentUser.role === 'ADMIN' && (
                  <p className="text-[10px] text-amber-400/90 mt-1">
                    Admins can create Admin, Vice Admin, and Employee roles. Super Admin creation is strictly prohibited.
                  </p>
                )}
              </div>

              {/* Optional Employee Association */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Optional Employee Association
                </label>
                <select
                  value={newEmployeeId}
                  onChange={(e) => {
                    const empId = e.target.value;
                    setNewEmployeeId(empId);
                    if (empId) {
                      const emp = companyEmployees.find((item) => item.id === empId);
                      if (emp) {
                        if (!newFullName) setNewFullName(emp.fullName);
                        if (!newEmail && emp.email) setNewEmail(emp.email);
                      }
                    }
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- No Employee Link (Standalone Account) --</option>
                  {companyEmployees.map((emp) => {
                    const isLinked = Boolean(emp.userId);
                    return (
                      <option key={emp.id} value={emp.id} disabled={isLinked}>
                        {emp.fullName} ({emp.employeeCode}) {isLinked ? '• [Already Has Login]' : ''}
                      </option>
                    );
                  })}
                </select>
                <p className="text-[10px] text-slate-400 mt-1">
                  Associates this user login directly with an HR employee record in the current company.
                </p>
              </div>

              {/* Active / Inactive Status */}
              <div className="pt-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newIsActive}
                    onChange={(e) => setNewIsActive(e.target.checked)}
                    className="w-4 h-4 rounded bg-slate-950 border-slate-700 text-indigo-600 focus:ring-0 cursor-pointer"
                  />
                  <span className="text-xs text-slate-200">
                    Account Active (User can authenticate immediately upon creation)
                  </span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingCreate}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition cursor-pointer disabled:opacity-50"
                >
                  {isSubmittingCreate ? 'Creating Account...' : 'Create User Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: Reset Password */}
      {resetPasswordUserId && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-amber-400" />
                Reset User Password
              </h3>
              <button
                onClick={() => setResetPasswordUserId(null)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {resetError && (
              <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3 text-xs text-red-200">
                {resetError}
              </div>
            )}

            <form onSubmit={handleResetPassword} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  New Password <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showResetPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={resetPasswordValue}
                    onChange={(e) => setResetPasswordValue(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPassword(!showResetPassword)}
                    aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                    title={showResetPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-200 transition cursor-pointer"
                  >
                    {showResetPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 mt-1">
                  Resetting the password will revoke any active sessions for this user.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setResetPasswordUserId(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingReset}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold shadow transition cursor-pointer disabled:opacity-50"
                >
                  {isSubmittingReset ? 'Updating...' : 'Set New Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
