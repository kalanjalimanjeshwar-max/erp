import {createRoot} from 'react-dom/client';
import '@fontsource/noto-sans-kannada/400.css';
import '@fontsource/noto-sans-kannada/600.css';
import '@fontsource/noto-sans-kannada/700.css';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
