import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
import AdminApp from './admin/AdminApp.jsx';
import FairPage from './components/FairPage.jsx';

const path = location.pathname;
const Root = path.startsWith('/admin') ? AdminApp : path.startsWith('/fair') ? FairPage : App;
createRoot(document.getElementById('root')).render(<Root />);
