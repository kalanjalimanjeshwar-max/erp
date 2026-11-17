import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Users,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
  X,
  Edit2,
  Eye,
  EyeOff,
  DollarSign,
  Lock,
  BookOpen,
  Ban,
  UserCheck,
  History,
  Fingerprint,
  Server,
  Trash2,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import {
  EmployeeItem,
  EmployeeStatus,
  EmploymentType,
  DepartmentItem,
  DesignationItem,
  AccountLedgerItem,
  SalaryRevisionItem,
  AuthUser,
  CreateEmployeeRequest,
  UpdateEmployeeRequest,
  CreateEmployeeLoginRequest,
  CreateSalaryRevisionRequest,
  CompanyProfile,
  BiometricTerminalEnrollmentOptionsResponse,
  EmployeeBiometricMappingInput,
} from '../../shared/types.ts';
import { formatMoney, getCurrencySymbol } from '../../shared/currency.ts';

interface EmployeesPageProps {
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  isSelfServiceOnly?: boolean;
}

export const EmployeesPage: React.FC<EmployeesPageProps> = ({
  currentUser,
  companyProfile,
  isSelfServiceOnly = false,
}) => {
  const isEmployeeRole = currentUser.role === 'EMPLOYEE';
  const showSelfServiceOnly = isSelfServiceOnly || isEmployeeRole;
  const baseCurrency = companyProfile?.currency;
  const roundingPrecision = companyProfile?.roundingPrecision;
  const currencySymbol = getCurrencySymbol(baseCurrency);

  // List State
  const [employees, setEmployees] = useState<EmployeeItem[]>([]);
  const [totalEmployees, setTotalEmployees] = useState(0);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [designations, setDesignations] = useState<DesignationItem[]>([]);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [biometricOptions, setBiometricOptions] =
    useState<BiometricTerminalEnrollmentOptionsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [designationFilter, setDesignationFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<EmployeeStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  // Self Profile (for EMPLOYEE role)
  const [selfEmployee, setSelfEmployee] = useState<EmployeeItem | null>(null);

  // Detail Modal State
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeItem | null>(null);
  const [detailTab, setDetailTab] = useState<'PROFILE' | 'SALARY' | 'LEDGER' | 'LOGIN'>('PROFILE');
  const [salaries, setSalaries] = useState<SalaryRevisionItem[]>([]);
  const [isLoadingSalaries, setIsLoadingSalaries] = useState(false);

  // Add/Edit Employee Modal State
  const [isEmployeeModalOpen, setIsEmployeeModalOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<EmployeeItem | null>(null);
  const [formCode, setFormCode] = useState('');
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formPhotoUrl, setFormPhotoUrl] = useState('');
  const [formDob, setFormDob] = useState('');
  const [formDoj, setFormDoj] = useState(new Date().toISOString().split('T')[0]);
  const [formDeptId, setFormDeptId] = useState('');
  const [formDesigId, setFormDesigId] = useState('');
  const [formEmpType, setFormEmpType] = useState<EmploymentType>('FULL_TIME');
  const [formStatus, setFormStatus] = useState<EmployeeStatus>('ACTIVE');
  const [formNotes, setFormNotes] = useState('');
  const [formInitialSalary, setFormInitialSalary] = useState('');
  const [formMappings, setFormMappings] = useState<EmployeeBiometricMappingInput[]>([]);
  const [terminalSearch, setTerminalSearch] = useState('');
  const [isTerminalDropdownOpen, setIsTerminalDropdownOpen] = useState(false);
  const [selectedTerminalId, setSelectedTerminalId] = useState('');
  const [enrollmentInput, setEnrollmentInput] = useState('');
  const [selectedDeviceUserDropdownId, setSelectedDeviceUserDropdownId] = useState('');
  const [isRefreshingBiometricOptions, setIsRefreshingBiometricOptions] = useState(false);
  const [biometricRefreshError, setBiometricRefreshError] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Activate / Deactivate State
  const [deactivateTarget, setDeactivateTarget] = useState<EmployeeItem | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [activatingEmployeeId, setActivatingEmployeeId] = useState<string | null>(null);

  // New Salary Revision Form State
  const [newSalary, setNewSalary] = useState('');
  const [newSalaryEffectiveFrom, setNewSalaryEffectiveFrom] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [newSalaryReason, setNewSalaryReason] = useState('Annual Appraisal / Adjustment');
  const [newSalaryNotes, setNewSalaryNotes] = useState('');
  const [isAddingSalary, setIsAddingSalary] = useState(false);

  // Create Login Form State
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [isCreatingLogin, setIsCreatingLogin] = useState(false);

  // Ledger Link State
  const [selectedLedgerId, setSelectedLedgerId] = useState('');
  const [isLinkingLedger, setIsLinkingLedger] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (showSelfServiceOnly) {
        // Load self profile exclusively
        const self = await api.getEmployeeSelf();
        setSelfEmployee(self);
        setSelectedEmployee(self);
        // Load own salary history
        const salList = await api.getEmployeeSalaries(self.id);
        setSalaries(salList);
      } else {
        // Load full administrative employee directory, masters, and active biometric terminal options
        const [empRes, deptList, desigList, ledgerList, bioOpts] = await Promise.all([
          api.getEmployees({
            departmentId: departmentFilter || undefined,
            designationId: designationFilter || undefined,
            status: statusFilter === 'ALL' ? undefined : statusFilter,
            search: search.trim() || undefined,
            page: currentPage,
            limit: 20,
          }),
          api.getDepartments(),
          api.getDesignations(),
          api.getLedgers(),
          api.getEmployeeBiometricOptions().catch(() => null),
        ]);

        setEmployees(empRes.items);
        setTotalEmployees(empRes.total);
        setDepartments(deptList);
        setDesignations(desigList);
        setLedgers(ledgerList);
        setBiometricOptions(bioOpts);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load employee records.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [showSelfServiceOnly, departmentFilter, designationFilter, statusFilter, search, currentPage]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load salaries when selected employee changes
  const loadSalariesForEmployee = async (empId: string) => {
    setIsLoadingSalaries(true);
    try {
      const salList = await api.getEmployeeSalaries(empId);
      setSalaries(salList);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      }
    } finally {
      setIsLoadingSalaries(false);
    }
  };

  const handleOpenDetailModal = (emp: EmployeeItem) => {
    setSelectedEmployee(emp);
    setDetailTab('PROFILE');
    setLoginEmail(emp.email || `${emp.employeeCode.toLowerCase()}@company.local`);
    setLoginPassword('');
    loadSalariesForEmployee(emp.id);
  };

  const activeTerminals = useMemo(
    () => biometricOptions?.terminals || [],
    [biometricOptions]
  );

  const filteredTerminals = useMemo(() => {
    const q = terminalSearch.trim().toLowerCase();
    if (!q) return activeTerminals;
    return activeTerminals.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.terminalModel.toLowerCase().includes(q) ||
        t.deviceSerialNumber.toLowerCase().includes(q) ||
        (t.ipAddress && t.ipAddress.toLowerCase().includes(q)) ||
        (t.location && t.location.toLowerCase().includes(q))
    );
  }, [activeTerminals, terminalSearch]);

  const selectedTerminal = useMemo(
    () => activeTerminals.find((t) => t.id === selectedTerminalId) || null,
    [activeTerminals, selectedTerminalId]
  );

  const handleRefreshBiometricOptions = useCallback(async (quiet = false) => {
    setIsRefreshingBiometricOptions(true);
    if (!quiet) {
      setBiometricRefreshError(null);
    }
    try {
      const bioOpts = await api.getEmployeeBiometricOptions();
      setBiometricOptions(bioOpts);
      setBiometricRefreshError(null);
    } catch (err: unknown) {
      if (!quiet) {
        setBiometricRefreshError(
          err instanceof ApiError ? err.message : 'Failed to refresh biometric device users.'
        );
      }
    } finally {
      setIsRefreshingBiometricOptions(false);
    }
  }, []);

  const allDeviceUsersForSelected = useMemo(() => {
    if (!selectedTerminalId || !biometricOptions?.deviceUsersByTerminal) return [];
    return biometricOptions.deviceUsersByTerminal[selectedTerminalId] || [];
  }, [biometricOptions, selectedTerminalId]);

  const syncedDeviceUsersForSelected = useMemo(() => {
    const q = enrollmentInput.trim().toLowerCase();
    if (!q) return allDeviceUsersForSelected;
    return allDeviceUsersForSelected.filter(
      (u) =>
        u.enrollmentId.toLowerCase().includes(q) ||
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.cardNo && u.cardNo.toLowerCase().includes(q))
    );
  }, [allDeviceUsersForSelected, enrollmentInput]);

  const findExternalMappingConflict = useCallback(
    (terminalId: string, enrollmentId: string) => {
      const normalized = enrollmentId.trim();
      if (!terminalId || !normalized || !biometricOptions?.activeMappings) return null;
      return (
        biometricOptions.activeMappings.find(
          (m) =>
            m.terminalId === terminalId &&
            m.enrollmentId === normalized &&
            m.employeeId !== editingEmployee?.id
        ) || null
      );
    },
    [biometricOptions, editingEmployee]
  );

  const validateAndStageMapping = (
    terminalId: string,
    rawEnrollmentId: string,
    source: 'EXPLICIT' | 'DEVICE_SYNC' = 'EXPLICIT'
  ): EmployeeBiometricMappingInput | null => {
    const enrollmentId = rawEnrollmentId.trim();
    if (!terminalId) {
      setMappingError('Please select a registered biometric terminal first.');
      return null;
    }
    if (!enrollmentId) {
      setMappingError('Please enter or select a Biometric Enrollment ID.');
      return null;
    }
    if (formMappings.some((m) => m.terminalId === terminalId && m.enrollmentId === enrollmentId)) {
      setMappingError(`Enrollment ID '${enrollmentId}' is already added for this terminal.`);
      return null;
    }
    const conflict = findExternalMappingConflict(terminalId, enrollmentId);
    if (conflict) {
      setMappingError(
        `Enrollment ID '${enrollmentId}' on this terminal is already mapped to ${conflict.employeeName} (${conflict.employeeCode}).`
      );
      return null;
    }
    setMappingError(null);
    return {
      terminalId,
      enrollmentId,
      isActive: true,
      source,
    };
  };

  const handleAddMapping = (
    overrideEnrollmentId?: string,
    source: 'EXPLICIT' | 'DEVICE_SYNC' = 'EXPLICIT'
  ) => {
    const candidate = overrideEnrollmentId !== undefined ? overrideEnrollmentId : enrollmentInput;
    const staged = validateAndStageMapping(selectedTerminalId, candidate, source);
    if (!staged) return;
    setFormMappings((prev) => [...prev, staged]);
    setEnrollmentInput('');
    setSelectedDeviceUserDropdownId('');
    setMappingError(null);
  };

  const handleRemoveMapping = (terminalId: string, enrollmentId: string) => {
    setFormMappings((prev) =>
      prev.filter((m) => !(m.terminalId === terminalId && m.enrollmentId === enrollmentId))
    );
    setMappingError(null);
  };

  // Create / Update Employee submit
  const handleEmployeeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formCode.trim() || !formName.trim() || !formDoj) {
      setModalError('Employee code, full name, and date of joining are required.');
      return;
    }

    // If user typed an enrollment ID and selected a terminal without clicking "+ Add Mapping",
    // validate and include it cleanly so there is no silent data loss.
    let nextMappings = [...formMappings];
    if (selectedTerminalId && enrollmentInput.trim()) {
      const staged = validateAndStageMapping(selectedTerminalId, enrollmentInput, 'EXPLICIT');
      if (!staged) {
        return;
      }
      nextMappings = [...nextMappings, staged];
      setFormMappings(nextMappings);
      setEnrollmentInput('');
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setModalError(null);

    try {
      const primaryBioId = nextMappings[0]?.enrollmentId || null;

      if (editingEmployee) {
        const updatePayload: UpdateEmployeeRequest = {
          employeeCode: formCode.trim(),
          fullName: formName.trim(),
          email: formEmail.trim() || null,
          phone: formPhone.trim() || null,
          address: formAddress.trim() || null,
          photoUrl: formPhotoUrl.trim() || null,
          dateOfBirth: formDob || null,
          dateOfJoining: formDoj,
          departmentId: formDeptId || null,
          designationId: formDesigId || null,
          employmentType: formEmpType,
          status: formStatus,
          notes: formNotes.trim() || null,
          biometricDeviceId: primaryBioId,
          biometricMappings: nextMappings,
        };
        const updated = await api.updateEmployee(editingEmployee.id, updatePayload);
        setSuccessMessage(
          `Employee '${updated.fullName}' updated (${updated.status === 'ACTIVE' ? 'Active' : updated.status}).`
        );
        if (selectedEmployee?.id === updated.id) {
          setSelectedEmployee(updated);
        }
      } else {
        const createPayload: CreateEmployeeRequest = {
          employeeCode: formCode.trim(),
          fullName: formName.trim(),
          email: formEmail.trim() || null,
          phone: formPhone.trim() || null,
          address: formAddress.trim() || null,
          photoUrl: formPhotoUrl.trim() || null,
          dateOfBirth: formDob || null,
          dateOfJoining: formDoj,
          departmentId: formDeptId || null,
          designationId: formDesigId || null,
          employmentType: formEmpType,
          status: formStatus,
          notes: formNotes.trim() || null,
          biometricDeviceId: primaryBioId,
          biometricMappings: nextMappings,
          initialSalary: formInitialSalary ? formInitialSalary : undefined,
        };
        const created = await api.createEmployee(createPayload);
        setSuccessMessage(`Employee '${created.fullName}' (${created.employeeCode}) created successfully.`);
      }

      setIsEmployeeModalOpen(false);
      resetEmployeeForm();
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setModalError(err.message);
      } else {
        setModalError('Failed to save employee record.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetEmployeeForm = () => {
    setEditingEmployee(null);
    setFormCode('');
    setFormName('');
    setFormEmail('');
    setFormPhone('');
    setFormAddress('');
    setFormPhotoUrl('');
    setFormDob('');
    setFormDoj(new Date().toISOString().split('T')[0]);
    setFormDeptId('');
    setFormDesigId('');
    setFormEmpType('FULL_TIME');
    setFormStatus('ACTIVE');
    setFormNotes('');
    setFormInitialSalary('');
    setFormMappings([]);
    setTerminalSearch('');
    setIsTerminalDropdownOpen(false);
    setSelectedTerminalId(activeTerminals.length === 1 ? activeTerminals[0].id : '');
    setEnrollmentInput('');
    setSelectedDeviceUserDropdownId('');
    setBiometricRefreshError(null);
    setMappingError(null);
    setModalError(null);
  };

  const openEditEmployee = (emp: EmployeeItem) => {
    setEditingEmployee(emp);
    setFormCode(emp.employeeCode);
    setFormName(emp.fullName);
    setFormEmail(emp.email || '');
    setFormPhone(emp.phone || '');
    setFormAddress(emp.address || '');
    setFormPhotoUrl(emp.photoUrl || '');
    setFormDob(emp.dateOfBirth || '');
    setFormDoj(emp.dateOfJoining);
    setFormDeptId(emp.departmentId || '');
    setFormDesigId(emp.designationId || '');
    setFormEmpType(emp.employmentType);
    setFormStatus(emp.status);
    setFormNotes(emp.notes || '');
    setFormInitialSalary('');
    setFormMappings(
      (emp.biometricMappings || []).map((m) => ({
        terminalId: m.terminalId,
        enrollmentId: m.enrollmentId,
        isActive: m.isActive,
        source: m.source,
      }))
    );
    setTerminalSearch('');
    setIsTerminalDropdownOpen(false);
    setSelectedTerminalId(
      emp.biometricMappings?.[0]?.terminalId ||
        (activeTerminals.length === 1 ? activeTerminals[0].id : '')
    );
    setEnrollmentInput('');
    setSelectedDeviceUserDropdownId('');
    setBiometricRefreshError(null);
    setMappingError(null);
    setModalError(null);
    setIsEmployeeModalOpen(true);
    void handleRefreshBiometricOptions(true);
  };

  const handleActivateEmployee = async (emp: EmployeeItem) => {
    setActivatingEmployeeId(emp.id);
    setErrorMessage(null);
    try {
      const updated = await api.activateEmployee(emp.id);
      setSuccessMessage(
        `Employee '${updated.fullName}' (${updated.employeeCode}) activated. Any mapped pending biometric punches are queued for reconciliation.`
      );
      if (selectedEmployee?.id === updated.id) {
        setSelectedEmployee(updated);
      }
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to activate employee.');
      }
    } finally {
      setActivatingEmployeeId(null);
    }
  };

  const handleConfirmDeactivateEmployee = async () => {
    if (!deactivateTarget) return;
    setIsDeactivating(true);
    setErrorMessage(null);
    try {
      const updated = await api.deactivateEmployee(deactivateTarget.id);
      setSuccessMessage(
        `Employee '${updated.fullName}' (${updated.employeeCode}) set to Inactive. Historical records preserved.`
      );
      if (selectedEmployee?.id === updated.id) {
        setSelectedEmployee(updated);
      }
      setDeactivateTarget(null);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to deactivate employee.');
      }
    } finally {
      setIsDeactivating(false);
    }
  };

  // Add Salary Revision Submit
  const handleAddSalaryRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee) return;

    if (!newSalary || parseFloat(newSalary) < 0) {
      setErrorMessage('Salary must be a positive number.');
      return;
    }

    setIsAddingSalary(true);
    setErrorMessage(null);

    try {
      const payload: CreateSalaryRevisionRequest = {
        fixedSalary: newSalary,
        effectiveFrom: newSalaryEffectiveFrom,
        revisionReason: newSalaryReason.trim() || 'Salary Revision',
        notes: newSalaryNotes.trim() || null,
      };

      await api.createSalaryRevision(selectedEmployee.id, payload);
      setSuccessMessage('New salary revision recorded successfully.');
      setNewSalary('');
      setNewSalaryNotes('');
      loadSalariesForEmployee(selectedEmployee.id);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to add salary revision.');
      }
    } finally {
      setIsAddingSalary(false);
    }
  };

  // Create Login Account Submit
  const handleCreateLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee) return;

    if (!loginEmail.trim() || loginPassword.length < 8) {
      setErrorMessage('Valid email and password (minimum 8 characters) are required.');
      return;
    }

    setIsCreatingLogin(true);
    setErrorMessage(null);

    try {
      const payload: CreateEmployeeLoginRequest = {
        email: loginEmail.trim(),
        password: loginPassword,
        role: 'EMPLOYEE',
      };

      const updated = await api.createEmployeeLogin(selectedEmployee.id, payload);
      setSelectedEmployee(updated);
      setSuccessMessage(`User login account created for ${updated.fullName} (${updated.userEmail}).`);
      setLoginPassword('');
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to create login account.');
      }
    } finally {
      setIsCreatingLogin(false);
    }
  };

  // Toggle Login Status
  const handleToggleLoginStatus = async (isActive: boolean) => {
    if (!selectedEmployee) return;

    try {
      const updated = await api.toggleEmployeeLoginStatus(selectedEmployee.id, isActive);
      setSelectedEmployee(updated);
      setSuccessMessage(`User login status changed to ${isActive ? 'Active' : 'Inactive'}.`);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to update login status.');
      }
    }
  };

  // Link Accounting Ledger Submit
  const handleLinkLedger = async (createDedicated: boolean) => {
    if (!selectedEmployee) return;

    setIsLinkingLedger(true);
    setErrorMessage(null);

    try {
      const updated = await api.linkEmployeeLedger(selectedEmployee.id, {
        ledgerId: createDedicated ? undefined : selectedLedgerId,
        createLedger: createDedicated,
      });

      setSelectedEmployee(updated);
      setSuccessMessage(`Employee linked to General Ledger '${updated.ledgerName}'!`);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to link employee ledger.');
      }
    } finally {
      setIsLinkingLedger(false);
    }
  };

  const getStatusBadge = (status: EmployeeStatus) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="text-[11px] font-semibold text-emerald-400 whitespace-nowrap">
            Active
          </span>
        );
      case 'INACTIVE':
        return (
          <span className="text-[11px] font-medium text-slate-400 whitespace-nowrap">
            Inactive
          </span>
        );
      case 'EXITED':
        return (
          <span className="text-[11px] font-semibold text-rose-400 whitespace-nowrap">
            Exited
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Users className="w-6 h-6 text-indigo-400" />
            {showSelfServiceOnly ? 'My Employee Profile & Salary' : 'Employee Directory & Salary Structure'}
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            {showSelfServiceOnly
              ? 'View your employee record, employment details, and effective salary structure.'
              : 'Manage company personnel, departmental assignments, effective-dated salary structures, and general ledger linkages.'}
          </p>
        </div>

        {!showSelfServiceOnly && (
          <button
            onClick={() => {
              resetEmployeeForm();
              setIsEmployeeModalOpen(true);
              void handleRefreshBiometricOptions(true);
            }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Add Employee
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

      {/* Employee Self-Service View */}
      {showSelfServiceOnly && selfEmployee && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-2xl bg-indigo-950 border border-indigo-800 flex items-center justify-center text-xl font-bold text-indigo-300">
              {selfEmployee.photoUrl ? (
                <img
                  src={selfEmployee.photoUrl}
                  alt={selfEmployee.fullName}
                  className="w-full h-full object-cover rounded-2xl"
                />
              ) : (
                selfEmployee.fullName.charAt(0)
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-white">{selfEmployee.fullName}</h3>
                {getStatusBadge(selfEmployee.status)}
              </div>
              <p className="text-xs font-mono text-indigo-400">{selfEmployee.employeeCode}</p>
              <p className="text-xs text-slate-400 mt-1">
                {selfEmployee.designationName || 'No Designation'} • {selfEmployee.departmentName || 'No Department'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 space-y-1">
              <span className="text-slate-400 text-[10px] uppercase font-semibold">Joining Date</span>
              <div className="font-semibold text-slate-200">{selfEmployee.dateOfJoining}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 space-y-1">
              <span className="text-slate-400 text-[10px] uppercase font-semibold">Employment Type</span>
              <div className="font-semibold text-slate-200 capitalize">{selfEmployee.employmentType.replace('_', ' ').toLowerCase()}</div>
            </div>
            <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/60 space-y-1">
              <span className="text-emerald-400 text-[10px] uppercase font-semibold">Current Monthly Salary</span>
              <div className="font-mono font-bold text-emerald-300 text-sm">
                {formatMoney(selfEmployee.currentSalary || 0, baseCurrency, { decimals: roundingPrecision })}
              </div>
            </div>
          </div>

          {/* Salary History */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <History className="w-4 h-4 text-indigo-400" /> My Salary Revision History
            </h4>
            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-800/80 text-slate-400 uppercase text-[10px] font-semibold">
                  <tr>
                    <th className="py-2.5 px-3">Effective From</th>
                    <th className="py-2.5 px-3">Effective To</th>
                    <th className="py-2.5 px-3 text-right">Fixed Monthly Salary</th>
                    <th className="py-2.5 px-3">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {salaries.map((sal) => (
                    <tr key={sal.id} className="hover:bg-slate-800/20">
                      <td className="py-2.5 px-3 font-medium text-white">{sal.effectiveFrom}</td>
                      <td className="py-2.5 px-3 text-slate-400">{sal.effectiveTo || 'Current / Ongoing'}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-400">
                        {formatMoney(sal.fixedSalary, baseCurrency, { decimals: roundingPrecision })}
                      </td>
                      <td className="py-2.5 px-3 text-slate-400">{sal.revisionReason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Administrative View: Directory & Filters */}
      {!showSelfServiceOnly && (
        <>
          {/* Filters Bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[220px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search code, name, email..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">Dept:</label>
                <select
                  value={departmentFilter}
                  onChange={(e) => setDepartmentFilter(e.target.value)}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">All Departments</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">Desig:</label>
                <select
                  value={designationFilter}
                  onChange={(e) => setDesignationFilter(e.target.value)}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">All Designations</option>
                  {designations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">Status:</label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as EmployeeStatus | 'ALL')}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                  <option value="EXITED">Exited</option>
                </select>
              </div>
            </div>

            <button
              onClick={loadData}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
            >
              Refresh
            </button>
          </div>

          {/* Employees Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            {isLoading ? (
              <div className="p-12 text-center text-xs text-slate-400">Loading employee directory...</div>
            ) : employees.length === 0 ? (
              <div className="p-12 text-center space-y-3">
                <Users className="w-10 h-10 text-slate-600 mx-auto" />
                <div className="text-sm font-semibold text-slate-300">No Employees Found</div>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  Add staff members with departments, designations, salary structures, and general ledger linkages.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-800/60 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4">Code</th>
                      <th className="py-3 px-4">Employee</th>
                      <th className="py-3 px-4">Department & Designation</th>
                      <th className="py-3 px-4">Biometric Mapping</th>
                      <th className="py-3 px-4">Joining Date</th>
                      <th className="py-3 px-4 text-right">Fixed Salary</th>
                      <th className="py-3 px-4 text-center">Ledger Link</th>
                      <th className="py-3 px-4 text-center">Login Account</th>
                      <th className="py-3 px-4 text-center">Status</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {employees.map((emp) => {
                      const primaryMapping = emp.biometricMappings?.[0];
                      const extraCount = (emp.biometricMappings?.length || 0) - 1;
                      return (
                      <tr key={emp.id} className="hover:bg-slate-800/40 transition">
                        <td className="py-3 px-4 font-mono tabular-nums font-semibold text-indigo-300">
                          {emp.employeeCode}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-100 flex items-center gap-2">
                            <span>{emp.fullName}</span>
                          </div>
                          {emp.email && <div className="text-[10px] text-slate-400">{emp.email}</div>}
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-slate-200 font-medium">
                            {emp.designationName || <span className="text-slate-500 italic">No Designation</span>}
                          </div>
                          <div className="text-[10px] text-indigo-400">
                            {emp.departmentName || <span className="text-slate-500 italic">No Dept</span>}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          {primaryMapping ? (
                            <div className="space-y-0.5">
                              <div className="text-slate-200 font-medium truncate max-w-[170px]" title={primaryMapping.terminalName || primaryMapping.terminalId}>
                                {primaryMapping.terminalName || 'Biometric Terminal'}
                              </div>
                              <div className="text-[11px] font-mono tabular-nums text-indigo-300">
                                ID {primaryMapping.enrollmentId}
                                {extraCount > 0 ? ` · +${extraCount} more` : ''}
                              </div>
                            </div>
                          ) : emp.biometricDeviceId ? (
                            <div className="text-[11px] font-mono tabular-nums text-amber-300">
                              Legacy ID {emp.biometricDeviceId}
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-500">Unmapped</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-400 font-mono tabular-nums">{emp.dateOfJoining}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-emerald-400">
                          {emp.currentSalary ? (
                            formatMoney(emp.currentSalary, baseCurrency, { decimals: roundingPrecision })
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {emp.ledgerId ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-300">
                              <BookOpen className="w-3 h-3 text-indigo-400" /> Linked
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-500">Unlinked</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {emp.userId ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300">
                              <UserCheck className="w-3 h-3" /> Enabled
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-500">No Login</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">{getStatusBadge(emp.status)}</td>
                        <td className="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                          <button
                            onClick={() => handleOpenDetailModal(emp)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
                            title="View Employee Detail & Salary"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => openEditEmployee(emp)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
                            title="Edit Employee"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          {emp.status !== 'ACTIVE' ? (
                            <button
                              onClick={() => handleActivateEmployee(emp)}
                              disabled={activatingEmployeeId === emp.id}
                              className="inline-flex items-center gap-1 px-2 py-1 hover:bg-emerald-950/60 rounded text-emerald-400 hover:text-emerald-300 text-[11px] font-semibold transition cursor-pointer disabled:opacity-50"
                              title="Activate Employee"
                            >
                              <UserCheck className="w-3.5 h-3.5" />
                              <span>{activatingEmployeeId === emp.id ? 'Activating...' : 'Activate'}</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => setDeactivateTarget(emp)}
                              className="p-1 hover:bg-slate-800 rounded text-rose-400 hover:text-rose-300 transition cursor-pointer"
                              title="Deactivate Employee"
                            >
                              <Ban className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {totalEmployees > employees.length && (
            <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
              <span className="tabular-nums">
                Showing {employees.length} of {totalEmployees} employees
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded text-slate-200 cursor-pointer"
                >
                  Previous
                </button>
                <span className="font-mono tabular-nums text-slate-300">Page {currentPage}</span>
                <button
                  type="button"
                  disabled={currentPage * 20 >= totalEmployees}
                  onClick={() => setCurrentPage((p) => p + 1)}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded text-slate-200 cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Detail Modal (Profile, Salary Structure, Ledger Linkage, Login) */}
      {selectedEmployee && !showSelfServiceOnly && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full p-6 space-y-6 shadow-2xl my-6">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-indigo-950 border border-indigo-800 flex items-center justify-center font-bold text-lg text-indigo-300">
                  {selectedEmployee.fullName.charAt(0)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-white">{selectedEmployee.fullName}</h3>
                    {getStatusBadge(selectedEmployee.status)}
                  </div>
                  <p className="text-xs font-mono text-indigo-400">
                    {selectedEmployee.employeeCode} • {selectedEmployee.designationName || 'No Designation'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedEmployee(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Sub-Tabs */}
            <div className="flex gap-2 border-b border-slate-800 pb-2">
              <button
                onClick={() => setDetailTab('PROFILE')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  detailTab === 'PROFILE' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Profile & Employment
              </button>
              <button
                onClick={() => setDetailTab('SALARY')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                  detailTab === 'SALARY' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <DollarSign className="w-3.5 h-3.5" />
                Salary Structure ({salaries.length})
              </button>
              <button
                onClick={() => setDetailTab('LEDGER')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                  detailTab === 'LEDGER' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                Accounting Ledger
              </button>
              <button
                onClick={() => setDetailTab('LOGIN')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                  detailTab === 'LOGIN' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                Login Account
              </button>
            </div>

            {/* Sub-Tab 1: Profile Overview */}
            {detailTab === 'PROFILE' && (
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Department</span>
                    <div className="font-semibold text-slate-200">{selectedEmployee.departmentName || '—'}</div>
                  </div>
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Designation</span>
                    <div className="font-semibold text-slate-200">{selectedEmployee.designationName || '—'}</div>
                  </div>
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Employment Type</span>
                    <div className="font-semibold text-slate-200 capitalize">
                      {selectedEmployee.employmentType.replace('_', ' ').toLowerCase()}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Date of Joining</span>
                    <div className="font-semibold text-slate-200">{selectedEmployee.dateOfJoining}</div>
                  </div>
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Date of Birth</span>
                    <div className="font-semibold text-slate-200">{selectedEmployee.dateOfBirth || '—'}</div>
                  </div>
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Biometric Enrollment Mappings</span>
                    {selectedEmployee.biometricMappings && selectedEmployee.biometricMappings.length > 0 ? (
                      <div className="space-y-1 pt-0.5">
                        {selectedEmployee.biometricMappings.map((m) => (
                          <div key={m.id} className="font-mono tabular-nums text-indigo-300 text-[11px]">
                            {m.terminalName || m.terminalId}
                            {m.deviceSerialNumber ? ` (${m.deviceSerialNumber})` : ''} · ID {m.enrollmentId}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="font-mono tabular-nums text-slate-200">
                        {selectedEmployee.biometricDeviceId ? `Legacy ID ${selectedEmployee.biometricDeviceId}` : '—'}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Email & Phone</span>
                    <div className="text-slate-200">{selectedEmployee.email || 'No Email'}</div>
                    <div className="text-slate-400">{selectedEmployee.phone || 'No Phone'}</div>
                  </div>
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Address</span>
                    <div className="text-slate-300">{selectedEmployee.address || '—'}</div>
                  </div>
                </div>

                {selectedEmployee.notes && (
                  <div className="p-3 bg-slate-800/40 border border-slate-800 rounded-xl space-y-1">
                    <span className="text-slate-400 text-[10px] uppercase font-semibold">Notes & Remarks</span>
                    <div className="text-slate-300 whitespace-pre-line">{selectedEmployee.notes}</div>
                  </div>
                )}
              </div>
            )}

            {/* Sub-Tab 2: Salary Structure & Revision History */}
            {detailTab === 'SALARY' && (
              <div className="space-y-5">
                {/* Add Salary Revision Form */}
                <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5 text-indigo-400" /> New Effective Salary Revision
                  </h4>
                  <form onSubmit={handleAddSalaryRevision} className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <label className="block text-slate-400 mb-1">Monthly Salary ({currencySymbol}) *</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        required
                        placeholder="e.g. 5500.00"
                        value={newSalary}
                        onChange={(e) => setNewSalary(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Effective From *</label>
                      <input
                        type="date"
                        required
                        value={newSalaryEffectiveFrom}
                        onChange={(e) => setNewSalaryEffectiveFrom(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Revision Reason</label>
                      <input
                        type="text"
                        placeholder="e.g. Annual Appraisal, Promotion"
                        value={newSalaryReason}
                        onChange={(e) => setNewSalaryReason(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="submit"
                        disabled={isAddingSalary}
                        className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg text-xs cursor-pointer disabled:opacity-50"
                      >
                        {isAddingSalary ? 'Recording...' : 'Record Revision'}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Salary Revisions History Table */}
                <div className="border border-slate-800 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-800/80 text-slate-400 uppercase text-[10px] font-semibold">
                      <tr>
                        <th className="py-2.5 px-3">Effective From</th>
                        <th className="py-2.5 px-3">Effective To</th>
                        <th className="py-2.5 px-3 text-right">Fixed Monthly Salary</th>
                        <th className="py-2.5 px-3">Reason</th>
                        <th className="py-2.5 px-3">Recorded By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {isLoadingSalaries ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-slate-400">
                            Loading salary revisions...
                          </td>
                        </tr>
                      ) : salaries.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-slate-500">
                            No salary revisions recorded for this employee yet.
                          </td>
                        </tr>
                      ) : (
                        salaries.map((sal) => (
                          <tr key={sal.id} className="hover:bg-slate-800/20">
                            <td className="py-2.5 px-3 font-medium text-white">{sal.effectiveFrom}</td>
                            <td className="py-2.5 px-3 text-slate-400">
                              {sal.effectiveTo || <span className="text-emerald-400 font-semibold">Current / Ongoing</span>}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-400">
                              {formatMoney(sal.fixedSalary, baseCurrency, { decimals: roundingPrecision })}
                            </td>
                            <td className="py-2.5 px-3 text-slate-300">{sal.revisionReason || '—'}</td>
                            <td className="py-2.5 px-3 text-slate-400">{sal.createdByUserName || 'Admin'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Sub-Tab 3: Accounting Ledger Linkage */}
            {detailTab === 'LEDGER' && (
              <div className="space-y-4 text-xs">
                <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 space-y-2">
                  <div className="font-semibold text-slate-200 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-indigo-400" /> General Ledger Linkage
                  </div>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    Linking an accounting ledger allows future payroll, salary payable accruals, and advance disbursements to be properly booked to the general ledger without data duplication.
                  </p>
                </div>

                {selectedEmployee.ledgerId ? (
                  <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-800/60 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase font-bold text-emerald-400">Linked Account Ledger</div>
                      <div className="text-sm font-bold text-white mt-0.5">
                        {selectedEmployee.ledgerName}
                      </div>
                      <div className="text-xs font-mono text-emerald-300">
                        Code: {selectedEmployee.ledgerCode || '—'}
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-emerald-300">
                      Connected
                    </span>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-amber-950/30 border border-amber-800/50 text-amber-200">
                      <div className="font-semibold flex items-center gap-1.5">
                        <AlertCircle className="w-4 h-4" /> No Accounting Ledger Linked
                      </div>
                      <p className="mt-1 text-[11px] text-amber-300">
                        This employee does not currently have a linked ledger in the Chart of Accounts.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Option A: Create Dedicated Ledger */}
                      <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3">
                        <div className="font-bold text-white">Create Dedicated Ledger</div>
                        <p className="text-slate-400 text-[11px]">
                          Automatically creates a new company ledger named &quot;{selectedEmployee.fullName} ({selectedEmployee.employeeCode})&quot; under the Payroll/Liabilities group.
                        </p>
                        <button
                          type="button"
                          onClick={() => handleLinkLedger(true)}
                          disabled={isLinkingLedger}
                          className="w-full px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg cursor-pointer disabled:opacity-50"
                        >
                          {isLinkingLedger ? 'Creating...' : 'Create & Link Ledger'}
                        </button>
                      </div>

                      {/* Option B: Link Existing Ledger */}
                      <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3">
                        <div className="font-bold text-white">Link Existing Ledger</div>
                        <select
                          value={selectedLedgerId}
                          onChange={(e) => setSelectedLedgerId(e.target.value)}
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                        >
                          <option value="">-- Choose Account Ledger --</option>
                          {ledgers
                            .filter((l) => l.rootType === 'LIABILITY' || l.rootType === 'EXPENSE' || l.rootType === 'ASSET')
                            .map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.code ? `[${l.code}] ` : ''}{l.name} ({l.rootType})
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleLinkLedger(false)}
                          disabled={isLinkingLedger || !selectedLedgerId}
                          className="w-full px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-lg cursor-pointer disabled:opacity-50"
                        >
                          {isLinkingLedger ? 'Linking...' : 'Link Selected Ledger'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sub-Tab 4: Employee User Login */}
            {detailTab === 'LOGIN' && (
              <div className="space-y-4 text-xs">
                {selectedEmployee.userId ? (
                  <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[10px] uppercase font-bold text-slate-400">User Login Account</div>
                        <div className="text-sm font-bold text-white mt-0.5">{selectedEmployee.userEmail}</div>
                      </div>
                      <span
                        className={`text-xs font-semibold ${
                          selectedEmployee.userActive
                            ? 'text-emerald-300'
                            : 'text-rose-300'
                        }`}
                      >
                        {selectedEmployee.userActive ? 'Active Login' : 'Disabled'}
                      </span>
                    </div>

                    <div className="pt-2 border-t border-slate-700 flex justify-end">
                      {selectedEmployee.userActive ? (
                        <button
                          type="button"
                          onClick={() => handleToggleLoginStatus(false)}
                          className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white rounded-lg cursor-pointer"
                        >
                          Disable User Login
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleToggleLoginStatus(true)}
                          className="px-3 py-1.5 bg-emerald-600/80 hover:bg-emerald-600 text-white rounded-lg cursor-pointer"
                        >
                          Re-activate User Login
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-5 rounded-xl bg-slate-800/50 border border-slate-700 space-y-4 max-w-lg">
                    <div>
                      <h4 className="text-sm font-bold text-white">Create Employee Login</h4>
                      <p className="text-slate-400 text-[11px] mt-0.5">
                        Generate authentication credentials allowing this employee to log into the CoreERP portal.
                      </p>
                    </div>

                    <form onSubmit={handleCreateLogin} className="space-y-3">
                      <div>
                        <label className="block text-slate-400 mb-1">Email / Username *</label>
                        <input
                          type="email"
                          required
                          value={loginEmail}
                          onChange={(e) => setLoginEmail(e.target.value)}
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-400 mb-1">Initial Password (min 8 chars) *</label>
                        <div className="relative">
                          <input
                            type={showLoginPassword ? 'text' : 'password'}
                            required
                            minLength={8}
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                            placeholder="••••••••"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-10 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                          />
                          <button
                            type="button"
                            onClick={() => setShowLoginPassword(!showLoginPassword)}
                            aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                            title={showLoginPassword ? 'Hide password' : 'Show password'}
                            className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-200 transition cursor-pointer"
                          >
                            {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      <div className="pt-2">
                        <button
                          type="submit"
                          disabled={isCreatingLogin}
                          className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg cursor-pointer disabled:opacity-50"
                        >
                          {isCreatingLogin ? 'Creating Login...' : 'Create Employee Login Account'}
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add / Edit Employee Modal */}
      {isEmployeeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl my-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">
                {editingEmployee ? 'Edit Employee Record' : 'Add New Employee'}
              </h3>
              <button
                onClick={() => setIsEmployeeModalOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEmployeeSubmit} className="space-y-4 text-xs">
              {modalError && (
                <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{modalError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">
                    Employee Code <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. EMP-001"
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">
                    Full Name <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="John Doe"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">
                    Employment Status <span className="text-rose-400">*</span>
                  </label>
                  <select
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as EmployeeStatus)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="EXITED">Exited</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Department</label>
                  <select
                    value={formDeptId}
                    onChange={(e) => setFormDeptId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">-- Unassigned --</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Designation</label>
                  <select
                    value={formDesigId}
                    onChange={(e) => setFormDesigId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">-- Unassigned --</option>
                    {designations.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">
                    Date of Joining <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={formDoj}
                    onChange={(e) => setFormDoj(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Date of Birth</label>
                  <input
                    type="date"
                    value={formDob}
                    onChange={(e) => setFormDob(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Employment Type</label>
                  <select
                    value={formEmpType}
                    onChange={(e) => setFormEmpType(e.target.value as EmploymentType)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="FULL_TIME">Full Time</option>
                    <option value="PART_TIME">Part Time</option>
                    <option value="CONTRACT">Contract</option>
                    <option value="INTERN">Intern</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Email Address</label>
                  <input
                    type="email"
                    placeholder="john@company.local"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Phone Number</label>
                  <input
                    type="text"
                    placeholder="+91 98765 43210"
                    value={formPhone}
                    onChange={(e) => setFormPhone(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {!editingEmployee && (
                <div>
                  <label className="block text-emerald-400 font-semibold mb-1">
                    Initial Monthly Fixed Salary ({currencySymbol})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 25000.00 (Optional)"
                    value={formInitialSalary}
                    onChange={(e) => setFormInitialSalary(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono tabular-nums focus:outline-none focus:border-emerald-500"
                  />
                </div>
              )}

              {/* Searchable Biometric Terminal & Enrollment Mappings */}
              <div className="p-3.5 rounded-xl bg-slate-800/40 border border-slate-800 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-slate-200 font-semibold">
                    <Fingerprint className="w-4 h-4 text-indigo-400" />
                    <span>Biometric Terminal &amp; Enrollment Mappings</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {activeTerminals.length > 0 && (
                      <button
                        type="button"
                        disabled={isRefreshingBiometricOptions}
                        onClick={() => void handleRefreshBiometricOptions(false)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md text-[11px] font-medium text-indigo-300 hover:text-indigo-200 transition cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                      >
                        <RefreshCw
                          className={`w-3 h-3 ${isRefreshingBiometricOptions ? 'animate-spin' : ''}`}
                        />
                        <span>
                          {isRefreshingBiometricOptions ? 'Refreshing...' : 'Refresh Device Users'}
                        </span>
                      </button>
                    )}
                    <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                      {formMappings.length} mapped
                    </span>
                  </div>
                </div>

                {biometricRefreshError && (
                  <div className="p-2 rounded-lg bg-rose-950/50 border border-rose-800 text-[11px] text-rose-200">
                    {biometricRefreshError}
                  </div>
                )}

                {editingEmployee?.biometricDeviceId && formMappings.length === 0 && (
                  <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-800/50 text-[11px] text-amber-200">
                    Legacy Biometric Device ID <span className="font-mono">{editingEmployee.biometricDeviceId}</span> is recorded without a terminal binding. Select the terminal below and add Enrollment ID <span className="font-mono">{editingEmployee.biometricDeviceId}</span> to bind it explicitly.
                  </div>
                )}

                {activeTerminals.length === 0 ? (
                  <div className="p-3 rounded-lg bg-slate-900/70 border border-slate-800 text-[11px] text-slate-400 flex items-center gap-2">
                    <Server className="w-4 h-4 text-slate-500 shrink-0" />
                    <span>
                      No active biometric terminals are registered for this company. Register a terminal under Attendance &rarr; Biometric Devices first.
                    </span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {/* Searchable Biometric Terminal Selector */}
                      <div className="relative">
                        <label className="block text-slate-400 mb-1">Biometric Terminal</label>
                        <button
                          type="button"
                          onClick={() => setIsTerminalDropdownOpen((prev) => !prev)}
                          className="w-full flex items-center justify-between bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                        >
                          <span className="truncate">
                            {selectedTerminal
                              ? `${selectedTerminal.name} · ${selectedTerminal.deviceSerialNumber}`
                              : 'Select registered terminal...'}
                          </span>
                          <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-2" />
                        </button>

                        {isTerminalDropdownOpen && (
                          <div className="absolute z-20 mt-1 w-full bg-slate-900 border border-slate-700 rounded-xl shadow-xl overflow-hidden">
                            <div className="p-2 border-b border-slate-800">
                              <div className="relative">
                                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                                <input
                                  type="text"
                                  autoFocus
                                  placeholder="Search terminal name, model, serial, IP..."
                                  value={terminalSearch}
                                  onChange={(e) => setTerminalSearch(e.target.value)}
                                  className="w-full bg-slate-800 border border-slate-700 rounded-md pl-8 pr-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                                />
                              </div>
                            </div>
                            <div className="max-h-44 overflow-y-auto divide-y divide-slate-800/70">
                              {filteredTerminals.length === 0 ? (
                                <div className="p-3 text-[11px] text-slate-500 text-center">
                                  No active biometric terminals match &ldquo;{terminalSearch}&rdquo;.
                                </div>
                              ) : (
                                filteredTerminals.map((term) => (
                                  <button
                                    key={term.id}
                                    type="button"
                                    onClick={() => {
                                      setSelectedTerminalId(term.id);
                                      setSelectedDeviceUserDropdownId('');
                                      setIsTerminalDropdownOpen(false);
                                      setMappingError(null);
                                    }}
                                    className={`w-full text-left px-3 py-2 hover:bg-slate-800/80 transition cursor-pointer ${
                                      selectedTerminalId === term.id ? 'bg-indigo-950/50' : ''
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-semibold text-slate-100 truncate">
                                        {term.name}
                                      </span>
                                      <span
                                        className={`text-[10px] font-semibold shrink-0 ${
                                          term.status === 'ONLINE'
                                            ? 'text-emerald-400'
                                            : term.status === 'ERROR'
                                            ? 'text-rose-400'
                                            : 'text-slate-400'
                                        }`}
                                      >
                                        {term.status}
                                      </span>
                                    </div>
                                    <div className="text-[11px] text-slate-400 font-mono tabular-nums truncate">
                                      {term.terminalModel} · {term.deviceSerialNumber}
                                      {term.ipAddress ? ` · ${term.ipAddress}:${term.port}` : ''}
                                    </div>
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Synced Hardware User Dropdown */}
                      <div>
                        <label className="block text-slate-400 mb-1">
                          Hardware Enrolled Users
                        </label>
                        <div className="flex items-center gap-2">
                          <select
                            aria-label="Hardware Enrolled Users"
                            disabled={!selectedTerminalId || allDeviceUsersForSelected.length === 0}
                            value={selectedDeviceUserDropdownId}
                            onChange={(e) => {
                              const nextId = e.target.value;
                              setSelectedDeviceUserDropdownId(nextId);
                              setMappingError(null);
                              if (nextId) {
                                handleAddMapping(nextId, 'DEVICE_SYNC');
                              }
                            }}
                            className="flex-1 bg-slate-800 border border-slate-700 disabled:opacity-50 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
                          >
                            <option value="">
                              {!selectedTerminalId
                                ? 'Select a terminal first...'
                                : allDeviceUsersForSelected.length === 0
                                ? 'No synced hardware users available'
                                : `Select hardware user (${allDeviceUsersForSelected.length} synced)...`}
                            </option>
                            {allDeviceUsersForSelected.map((u) => {
                              const conflict = findExternalMappingConflict(
                                selectedTerminalId,
                                u.enrollmentId
                              );
                              const alreadyStaged = formMappings.some(
                                (m) =>
                                  m.terminalId === selectedTerminalId &&
                                  m.enrollmentId === u.enrollmentId
                              );
                              const labelParts = [
                                `${u.enrollmentId} — ${u.name || 'Unnamed User'}`,
                              ];
                              if (u.uid !== undefined && u.uid !== null) {
                                labelParts.push(`UID ${u.uid}`);
                              }
                              if (u.cardNo) {
                                labelParts.push(`Card ${u.cardNo}`);
                              }
                              if (alreadyStaged) {
                                labelParts.push('[Added]');
                              } else if (conflict) {
                                labelParts.push(`[Mapped: ${conflict.employeeCode}]`);
                              }
                              return (
                                <option
                                  key={u.enrollmentId}
                                  value={u.enrollmentId}
                                  disabled={Boolean(conflict) || alreadyStaged}
                                >
                                  {labelParts.join(' · ')}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Per-Terminal Hardware User Sync Status / Empty / Error Message */}
                    {selectedTerminal && (
                      <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-1 text-[11px]">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400 font-mono tabular-nums">
                          <span>
                            Last user sync:{' '}
                            <span className="text-slate-200">
                              {selectedTerminal.lastUserSyncAt
                                ? new Date(selectedTerminal.lastUserSyncAt).toLocaleString()
                                : 'Never'}
                            </span>
                            {typeof selectedTerminal.discoveredUserCount === 'number' && (
                              <>
                                {' '}
                                · Discovered: {selectedTerminal.discoveredUserCount}
                              </>
                            )}
                            {typeof selectedTerminal.syncedUserCount === 'number' && (
                              <>
                                {' '}
                                · Synced: {selectedTerminal.syncedUserCount}
                              </>
                            )}
                          </span>
                          {selectedTerminal.userSyncRequestedAt && (
                            <span className="text-indigo-300">Bridge user sync queued</span>
                          )}
                        </div>

                        {selectedTerminal.lastUserSyncError && (
                          <div className="text-rose-300 font-mono">
                            Hardware user sync error: {selectedTerminal.lastUserSyncError}
                          </div>
                        )}

                        {allDeviceUsersForSelected.length === 0 && !selectedTerminal.lastUserSyncError && (
                          <div className="text-slate-400">
                            {selectedTerminal.lastUserSyncAt
                              ? 'Hardware reported 0 enrolled users on the selected terminal. Enroll the user on the terminal or use the Manual Enrollment ID Fallback below.'
                              : 'No hardware users synced yet for this terminal. Run Sync Device Users on the Biometric Devices page, then click Refresh Device Users.'}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Manual Enrollment ID Fallback */}
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <label className="block text-slate-300 font-medium">
                          Manual Enrollment ID Fallback
                        </label>
                        <span className="text-[11px] text-slate-400">
                          Use when hardware user sync is unavailable or to filter synced users
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder={
                            selectedTerminal
                              ? 'Filter synced hardware users or enter fallback ID (e.g. 101)'
                              : 'Select a terminal first'
                          }
                          disabled={!selectedTerminalId}
                          value={enrollmentInput}
                          onChange={(e) => {
                            setEnrollmentInput(e.target.value);
                            setMappingError(null);
                          }}
                          className="flex-1 bg-slate-800 border border-slate-700 disabled:opacity-50 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
                        />
                        <button
                          type="button"
                          disabled={!selectedTerminalId || !enrollmentInput.trim()}
                          onClick={() => handleAddMapping()}
                          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          + Add Mapping
                        </button>
                      </div>
                    </div>

                    {/* Real-time duplicate conflict check indicator */}
                    {selectedTerminalId &&
                      enrollmentInput.trim() &&
                      (() => {
                        const liveConflict = findExternalMappingConflict(
                          selectedTerminalId,
                          enrollmentInput
                        );
                        if (!liveConflict) return null;
                        return (
                          <div className="p-2 rounded-lg bg-rose-950/50 border border-rose-800 text-[11px] text-rose-200">
                            Enrollment ID <span className="font-mono">{enrollmentInput.trim()}</span> on this terminal is already mapped to {liveConflict.employeeName} ({liveConflict.employeeCode}).
                          </div>
                        );
                      })()}

                    {/* Quick-select filtered hardware users list (real device users only) */}
                    {selectedTerminalId && syncedDeviceUsersForSelected.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[11px] text-slate-400">
                          Synced Hardware Users on {selectedTerminal?.name} ({syncedDeviceUsersForSelected.length}):
                        </div>
                        <div className="max-h-28 overflow-y-auto border border-slate-800 rounded-lg divide-y divide-slate-800/70 bg-slate-900/60">
                          {syncedDeviceUsersForSelected.map((u) => {
                            const conflict = findExternalMappingConflict(
                              selectedTerminalId,
                              u.enrollmentId
                            );
                            const alreadyStaged = formMappings.some(
                              (m) =>
                                m.terminalId === selectedTerminalId &&
                                m.enrollmentId === u.enrollmentId
                            );
                            return (
                              <button
                                key={u.enrollmentId}
                                type="button"
                                disabled={Boolean(conflict) || alreadyStaged}
                                onClick={() => handleAddMapping(u.enrollmentId, 'DEVICE_SYNC')}
                                className="w-full text-left px-3 py-1.5 flex items-center justify-between gap-2 hover:bg-slate-800/70 disabled:opacity-50 text-[11px] cursor-pointer"
                              >
                                <span className="font-mono tabular-nums text-slate-200 truncate">
                                  ID {u.enrollmentId}
                                  {u.name ? ` · ${u.name}` : ''}
                                  {u.uid !== undefined && u.uid !== null ? ` · UID ${u.uid}` : ''}
                                  {u.cardNo ? ` · Card ${u.cardNo}` : ''}
                                </span>
                                <span className="text-slate-400 shrink-0">
                                  {alreadyStaged
                                    ? 'Added'
                                    : conflict
                                    ? `Mapped to ${conflict.employeeCode}`
                                    : 'Select'}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {mappingError && (
                      <div className="p-2 rounded-lg bg-rose-950/50 border border-rose-800 text-[11px] text-rose-200">
                        {mappingError}
                      </div>
                    )}
                  </div>
                )}

                {/* Mapped Terminal List */}
                {formMappings.length > 0 && (
                  <div className="border border-slate-800 rounded-lg divide-y divide-slate-800 bg-slate-900/50">
                    {formMappings.map((m) => {
                      const term = activeTerminals.find((t) => t.id === m.terminalId);
                      return (
                        <div
                          key={`${m.terminalId}::${m.enrollmentId}`}
                          className="px-3 py-2 flex items-center justify-between gap-3 text-[11px]"
                        >
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-200 truncate">
                              {term ? term.name : m.terminalId}
                              {term ? (
                                <span className="font-mono text-slate-400 font-normal">
                                  {' '}
                                  · {term.terminalModel} · {term.deviceSerialNumber}
                                </span>
                              ) : null}
                            </div>
                            <div className="font-mono tabular-nums text-indigo-300">
                              Enrollment ID: {m.enrollmentId}
                              <span className="font-sans text-slate-400">
                                {' '}
                                · {m.source === 'DEVICE_SYNC' ? 'Hardware Synced' : 'Manual Entry'}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveMapping(m.terminalId, m.enrollmentId)}
                            className="p-1 text-slate-400 hover:text-rose-400 cursor-pointer shrink-0"
                            title="Remove biometric mapping"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Residential Address</label>
                <input
                  type="text"
                  placeholder="Street, City, State, Country"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Internal Notes</label>
                <textarea
                  rows={2}
                  placeholder="HR notes or emergency contact info"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsEmployeeModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving...' : editingEmployee ? 'Update Employee' : 'Create Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* In-App Employee Deactivation Confirmation Modal */}
      {deactivateTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white">Deactivate Employee</h3>
                <p className="text-xs text-slate-400">
                  {deactivateTarget.fullName} ({deactivateTarget.employeeCode})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeactivateTarget(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-800/50 border border-slate-700 text-xs text-slate-300 leading-relaxed space-y-1.5">
              <p>
                Deactivating this employee preserves all historical attendance, salary revisions, payroll records, and audit logs.
              </p>
              <p className="text-slate-400">
                New biometric punches received while the employee is Inactive will be recorded in the punch log as <span className="font-mono text-slate-200">IGNORED</span> and will not create attendance entries. You can re-activate this employee anytime.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setDeactivateTarget(null)}
                disabled={isDeactivating}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeactivateEmployee}
                disabled={isDeactivating}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-50"
              >
                {isDeactivating ? 'Deactivating...' : 'Confirm Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
