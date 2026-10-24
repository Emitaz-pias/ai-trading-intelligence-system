import React from 'react';
import ReactDOM from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import App from './App';
import './styles.css';

const theme = createTheme({
  palette: {
    mode: 'dark', background: { default: '#0b1015', paper: '#111a22' },
    primary: { main: '#49d4b3' }, secondary: { main: '#73889b' },
    success: { main: '#49d4b3' }, warning: { main: '#f5bd63' }, error: { main: '#ff737d' },
    text: { primary: '#e8eef3', secondary: '#8999a8' }, divider: 'rgba(143, 162, 178, 0.14)',
  },
  typography: { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', h1: { fontWeight: 650, letterSpacing: '-0.04em' }, h2: { fontWeight: 650, letterSpacing: '-0.035em' }, h3: { fontWeight: 650, letterSpacing: '-0.03em' }, button: { textTransform: 'none', fontWeight: 600 } },
  shape: { borderRadius: 12 },
  components: {
    MuiCard: { styleOverrides: { root: { backgroundImage: 'none', border: '1px solid rgba(143, 162, 178, 0.14)', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' } } },
    MuiButton: { styleOverrides: { root: { borderRadius: 9 } } },
    MuiOutlinedInput: { styleOverrides: { root: { backgroundColor: 'rgba(5, 10, 14, 0.35)' } } },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider></React.StrictMode>,
);
