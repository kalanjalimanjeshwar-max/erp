import React, { useState, useEffect, useCallback } from 'react';
import {
  Building2,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
  X,
  Edit2,
  Users,
  Briefcase,
  Ban,
  Layers,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import {
  DepartmentItem,
  DesignationItem,
  AuthUser,
  CreateDepartmentRequest,
  CreateDesignationRequest,
} from '../../shared/types.ts';

interface DepartmentsPageProps {
  currentUser: AuthUser;
}

export const DepartmentsPage: React.FC<DepartmentsPageProps> = ({ currentUser }) => {
  const [activeTab, setActiveTab] = useState<'DEPARTMENTS' | 'DESIGNATIONS'>('DEPARTMENTS');

  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [designations, setDesignations] = useState<DesignationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [search, setSearch] = useState('');

  // Department Modal State
  const [isDeptModalOpen, setIsDeptModalOpen] = useState(false);
  const [editingDept, setEditingDept] = useState<DepartmentItem | null>(null);
  const [deptCode, setDeptCode] = useState('');
  const [deptName, setDeptName] = useState('');
  const [deptDesc, setDeptDesc] = useState('');

  // Designation Modal State
  const [isDesigModalOpen, setIsDesigModalOpen] = useState(false);
  const [editingDesig, setEditingDesig] = useState<DesignationItem | null>(null);
  const [desigCode, setDesigCode] = useState('');
  const [desigName, setDesigName] = useState('');
  const [desigDesc, setDesigDesc] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEmployee = currentUser.role === 'EMPLOYEE';

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [deptList, desigList] = await Promise.all([
        api.getDepartments(true),
        api.getDesignations(true),
      ]);
      setDepartments(deptList);
      setDesignations(desigList);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load master records.');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle Department Save
  const handleSaveDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptCode.trim() || !deptName.trim()) {
      setErrorMessage('Department code and name are required.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (editingDept) {
        await api.updateDepartment(editingDept.id, {
          code: deptCode.trim(),
          name: deptName.trim(),
          description: deptDesc.trim() || null,
        });
        setSuccessMessage(`Department '${deptName}' updated successfully.`);
      } else {
        const payload: CreateDepartmentRequest = {
          code: deptCode.trim(),
          name: deptName.trim(),
          description: deptDesc.trim() || null,
        };
        await api.createDepartment(payload);
        setSuccessMessage(`Department '${deptName}' created successfully.`);
      }
      setIsDeptModalOpen(false);
      resetDeptForm();
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to save department.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeactivateDept = async (dept: DepartmentItem) => {
    if (!confirm(`Are you sure you want to deactivate department '${dept.name}'? Existing employee records will be preserved.`)) {
      return;
    }
    try {
      await api.deactivateDepartment(dept.id);
      setSuccessMessage(`Department '${dept.name}' deactivated.`);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to deactivate department.');
      }
    }
  };

  const resetDeptForm = () => {
    setEditingDept(null);
    setDeptCode('');
    setDeptName('');
    setDeptDesc('');
  };

  const openEditDept = (dept: DepartmentItem) => {
    setEditingDept(dept);
    setDeptCode(dept.code);
    setDeptName(dept.name);
    setDeptDesc(dept.description || '');
    setIsDeptModalOpen(true);
  };

  // Handle Designation Save
  const handleSaveDesignation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!desigCode.trim() || !desigName.trim()) {
      setErrorMessage('Designation code and name are required.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (editingDesig) {
        await api.updateDesignation(editingDesig.id, {
          code: desigCode.trim(),
          name: desigName.trim(),
          description: desigDesc.trim() || null,
        });
        setSuccessMessage(`Designation '${desigName}' updated successfully.`);
      } else {
        const payload: CreateDesignationRequest = {
          code: desigCode.trim(),
          name: desigName.trim(),
          description: desigDesc.trim() || null,
        };
        await api.createDesignation(payload);
        setSuccessMessage(`Designation '${desigName}' created successfully.`);
      }
      setIsDesigModalOpen(false);
      resetDesigForm();
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to save designation.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeactivateDesig = async (desig: DesignationItem) => {
    if (!confirm(`Are you sure you want to deactivate designation '${desig.name}'? Existing employee records will be preserved.`)) {
      return;
    }
    try {
      await api.deactivateDesignation(desig.id);
      setSuccessMessage(`Designation '${desig.name}' deactivated.`);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to deactivate designation.');
      }
    }
  };

  const resetDesigForm = () => {
    setEditingDesig(null);
    setDesigCode('');
    setDesigName('');
    setDesigDesc('');
  };

  const openEditDesig = (desig: DesignationItem) => {
    setEditingDesig(desig);
    setDesigCode(desig.code);
    setDesigName(desig.name);
    setDesigDesc(desig.description || '');
    setIsDesigModalOpen(true);
  };

  // Filtered lists
  const filteredDepartments = departments.filter(
    (d) =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.code.toLowerCase().includes(search.toLowerCase())
  );

  const filteredDesignations = designations.filter(
    (d) =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.code.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-indigo-400" />
            Departments & Designations
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Configure company-scoped organizational hierarchy, departmental units, and job role classifications.
          </p>
        </div>

        {!isEmployee && (
          <button
            onClick={() => {
              if (activeTab === 'DEPARTMENTS') {
                resetDeptForm();
                setIsDeptModalOpen(true);
              } else {
                resetDesigForm();
                setIsDesigModalOpen(true);
              }
            }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {activeTab === 'DEPARTMENTS' ? 'Add Department' : 'Add Designation'}
          </button>
        )}
      </div>

      {/* Alerts */}
      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-800 text-rose-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="cursor-pointer text-rose-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-800 text-emerald-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="cursor-pointer text-emerald-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Tabs & Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-3">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('DEPARTMENTS')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'DEPARTMENTS'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800/80 text-slate-400 hover:text-white'
            }`}
          >
            <Building2 className="w-4 h-4" />
            Departments ({departments.length})
          </button>

          <button
            onClick={() => setActiveTab('DESIGNATIONS')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'DESIGNATIONS'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800/80 text-slate-400 hover:text-white'
            }`}
          >
            <Briefcase className="w-4 h-4" />
            Designations ({designations.length})
          </button>
        </div>

        <div className="relative min-w-[240px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search code or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Departments Table */}
      {activeTab === 'DEPARTMENTS' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          {isLoading ? (
            <div className="p-12 text-center text-xs text-slate-400">Loading departments...</div>
          ) : filteredDepartments.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <Building2 className="w-10 h-10 text-slate-600 mx-auto" />
              <div className="text-sm font-semibold text-slate-300">No Departments Found</div>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Define operational departments like Engineering, Finance, Operations, or Human Resources.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-800/60 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Code</th>
                    <th className="py-3 px-4">Department Name</th>
                    <th className="py-3 px-4">Description</th>
                    <th className="py-3 px-4 text-center">Active Employees</th>
                    <th className="py-3 px-4 text-center">Status</th>
                    {!isEmployee && <th className="py-3 px-4 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {filteredDepartments.map((dept) => (
                    <tr key={dept.id} className="hover:bg-slate-800/40 transition">
                      <td className="py-3 px-4 font-mono font-semibold text-indigo-300">
                        {dept.code}
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-100">{dept.name}</td>
                      <td className="py-3 px-4 text-slate-400 max-w-md truncate">
                        {dept.description || '—'}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                          <Users className="w-3 h-3 text-indigo-400" /> {dept.employeeCount ?? 0}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        {dept.isActive ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800">
                            Active
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                            Inactive
                          </span>
                        )}
                      </td>
                      {!isEmployee && (
                        <td className="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                          <button
                            onClick={() => openEditDept(dept)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
                            title="Edit Department"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          {dept.isActive && (
                            <button
                              onClick={() => handleDeactivateDept(dept)}
                              className="p-1 hover:bg-slate-800 rounded text-rose-400 hover:text-rose-300 transition cursor-pointer"
                              title="Deactivate Department"
                            >
                              <Ban className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Designations Table */}
      {activeTab === 'DESIGNATIONS' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          {isLoading ? (
            <div className="p-12 text-center text-xs text-slate-400">Loading designations...</div>
          ) : filteredDesignations.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <Briefcase className="w-10 h-10 text-slate-600 mx-auto" />
              <div className="text-sm font-semibold text-slate-300">No Designations Found</div>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Define job titles like Senior Engineer, Financial Analyst, or HR Manager.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-800/60 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Code</th>
                    <th className="py-3 px-4">Designation Title</th>
                    <th className="py-3 px-4">Description</th>
                    <th className="py-3 px-4 text-center">Active Employees</th>
                    <th className="py-3 px-4 text-center">Status</th>
                    {!isEmployee && <th className="py-3 px-4 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {filteredDesignations.map((desig) => (
                    <tr key={desig.id} className="hover:bg-slate-800/40 transition">
                      <td className="py-3 px-4 font-mono font-semibold text-indigo-300">
                        {desig.code}
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-100">{desig.name}</td>
                      <td className="py-3 px-4 text-slate-400 max-w-md truncate">
                        {desig.description || '—'}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                          <Users className="w-3 h-3 text-indigo-400" /> {desig.employeeCount ?? 0}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        {desig.isActive ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800">
                            Active
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                            Inactive
                          </span>
                        )}
                      </td>
                      {!isEmployee && (
                        <td className="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                          <button
                            onClick={() => openEditDesig(desig)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
                            title="Edit Designation"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          {desig.isActive && (
                            <button
                              onClick={() => handleDeactivateDesig(desig)}
                              className="p-1 hover:bg-slate-800 rounded text-rose-400 hover:text-rose-300 transition cursor-pointer"
                              title="Deactivate Designation"
                            >
                              <Ban className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Department Modal */}
      {isDeptModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">
                {editingDept ? 'Edit Department' : 'Create Department'}
              </h3>
              <button
                onClick={() => setIsDeptModalOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDepartment} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Department Code <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. ENG, HR, FIN"
                  value={deptCode}
                  onChange={(e) => setDeptCode(e.target.value.toUpperCase())}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Department Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Engineering & IT"
                  value={deptName}
                  onChange={(e) => setDeptName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
                <textarea
                  rows={3}
                  placeholder="Optional scope or notes"
                  value={deptDesc}
                  onChange={(e) => setDeptDesc(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsDeptModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving...' : editingDept ? 'Update Department' : 'Create Department'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Designation Modal */}
      {isDesigModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">
                {editingDesig ? 'Edit Designation' : 'Create Designation'}
              </h3>
              <button
                onClick={() => setIsDesigModalOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDesignation} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Designation Code <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. SENG, MGR, VP"
                  value={desigCode}
                  onChange={(e) => setDesigCode(e.target.value.toUpperCase())}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Designation Title <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Senior Software Engineer"
                  value={desigName}
                  onChange={(e) => setDesigName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
                <textarea
                  rows={3}
                  placeholder="Optional job level or notes"
                  value={desigDesc}
                  onChange={(e) => setDesigDesc(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsDesigModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving...' : editingDesig ? 'Update Designation' : 'Create Designation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
