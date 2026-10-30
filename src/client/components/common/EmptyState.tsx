import React, { ReactNode } from 'react';
import { FolderKanban } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  action,
}) => {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center bg-slate-900/50 border border-dashed border-slate-800 rounded-xl">
      <div className="w-12 h-12 flex items-center justify-center rounded-xl bg-slate-800/80 text-slate-400 mb-3 border border-slate-700/60">
        {icon || <FolderKanban className="w-6 h-6" />}
      </div>
      <h3 className="text-base font-semibold text-slate-200 mb-1">{title}</h3>
      <p className="text-sm text-slate-400 max-w-sm mb-4">{description}</p>
      {action && <div>{action}</div>}
    </div>
  );
};
