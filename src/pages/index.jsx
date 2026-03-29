import Layout from "./Layout.jsx";
import PredictiveMaintenance from "./PredictiveMaintenance";
import LoginPage from "./LoginPage";
import SubscriptionPage from "./SubscriptionPage";

import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';

const PAGES = {
    PredictiveMaintenance: PredictiveMaintenance,
}

function _getCurrentPage(url) {
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    let urlLastPart = url.split('/').pop();
    if (urlLastPart.includes('?')) {
        urlLastPart = urlLastPart.split('?')[0];
    }

    const pageName = Object.keys(PAGES).find(page => page.toLowerCase() === urlLastPart.toLowerCase());
    return pageName || Object.keys(PAGES)[0];
}

// Create a wrapper component that uses useLocation inside the Router context
function PagesContent() {
    const location = useLocation();
    const currentPage = _getCurrentPage(location.pathname);

    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/subscribe" element={
                <Layout currentPageName={currentPage}>
                    <SubscriptionPage />
                </Layout>
            } />
            <Route path="/" element={
                <Layout currentPageName={currentPage}>
                    <PredictiveMaintenance />
                </Layout>
            } />
            <Route path="*" element={
                <Layout currentPageName={currentPage}>
                    <PredictiveMaintenance />
                </Layout>
            } />
        </Routes>
    );
}

export default function Pages() {
    return (
        <Router>
            <PagesContent />
        </Router>
    );
}