import React, { Suspense, lazy } from "react";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Layout from "./Layout.jsx";
import LoginPage from "./LoginPage.jsx";

// ΓöÇΓöÇ Performance: Lazy-loaded page chunks ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const PredictiveMaintenance = lazy(() => import(/* webpackChunkName: "predictive" */ "./PredictiveMaintenance"));
const SubscriptionPage = lazy(() => import(/* webpackChunkName: "subscription" */ "./SubscriptionPage"));

function PageSkeleton() {
  return (
    <div className="animate-skeleton-pulse h-[80vh] w-full rounded-2xl border border-white/5" />
  );
}

function PagesContent() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route path="/subscribe" element={
          <Layout currentPageName="Subscription">
            <SubscriptionPage />
          </Layout>
        } />

        {/* New Empty Routes for Sidebar Map */}
        <Route path="/carops" element={<Layout currentPageName="Explore Vehicles"><div /></Layout>} />
        <Route path="/bookings" element={<Layout currentPageName="Bookings"><div /></Layout>} />
        <Route path="/trips" element={<Layout currentPageName="My Trips"><div /></Layout>} />
        <Route path="/saved" element={<Layout currentPageName="Saved"><div /></Layout>} />
        <Route path="/payments" element={<Layout currentPageName="Payments"><div /></Layout>} />
        <Route path="/settings" element={<Layout currentPageName="Settings"><div /></Layout>} />

        {/* Default */}
        <Route path="/" element={
          <Layout currentPageName="PredictiveMaintenance">
            <PredictiveMaintenance />
          </Layout>
        } />

        <Route path="*" element={
          <Layout currentPageName="PredictiveMaintenance">
            <PredictiveMaintenance />
          </Layout>
        } />
      </Routes>
    </Suspense>
  );
}

export default function Pages() {
  return (
    <Router basename={import.meta.env.BASE_URL}>
      <PagesContent />
    </Router>
  );
}
