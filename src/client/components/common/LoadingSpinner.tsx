import React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const LoadingSpinner: React.FC<LoadingProps> = ({
  message = 'Loading system data...',
  size = 'md',
}) => {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-7 h-7',
    lg: 'w-10 h-10',
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 text-slate-400">
      <Loader2 className={`${sizeClasses[size]} animate-spin text-indigo-500 mb-3`} />
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
};
