import React from 'react';
import { ShieldAlert, ArrowLeft } from 'lucide-react';

interface AccessDeniedProps {
  onBackToDashboard: () => void;
  requiredRole?: string;
}

export const AccessDenied: React.FC<AccessDeniedProps> = ({ onBackToDashboard, requiredRole }) => {
  return (
    <div className="max-w-md mx-auto my-12 bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-4 shadow-2xl">
      <div className="w-14 h-14 bg-red-950/60 border border-red-800/60 rounded-2xl flex items-center justify-center text-red-400 mx-auto">
        <ShieldAlert className="w-8 h-8" />
      </div>
      <h3 className="text-lg font-bold text-slate-100">Access Denied (403 Forbidden)</h3>
      <p className="text-xs text-slate-400 leading-relaxed">
        Your role does not possess the required permissions to access this module or action.
        {requiredRole && ` Elevated role required: ${requiredRole}.`}
      </p>
      <div className="pt-2">
        <button
          onClick={onBackToDashboard}
          className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition cursor-pointer border border-slate-700"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Dashboard</span>
        </button>
      </div>
    </div>
  );
};
