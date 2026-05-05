import React, { Suspense, lazy, Component } from "react";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Layout from "./Layout.jsx";
import LoginPage from "./LoginPage.jsx";

// ── Performance: Lazy-loaded page chunks ─────────────────────────────────────
const PredictiveMaintenance = lazy(() => import(/* webpackChunkName: "predictive" */ "./PredictiveMaintenance"));
const SubscriptionPage      = lazy(() => import(/* webpackChunkName: "subscription" */ "./SubscriptionPage"));
const Trips                 = lazy(() => import(/* webpackChunkName: "trips" */ "./Trips"));
const Settings              = lazy(() => import(/* webpackChunkName: "settings" */ "./Settings"));
const AIUpdates             = lazy(() => import(/* webpackChunkName: "ai-updates" */ "./AIUpdates"));
const ComingSoon            = lazy(() => import(/* webpackChunkName: "coming-soon" */ "./ComingSoon"));
const ValidationBench       = lazy(() => import(/* webpackChunkName: "validation" */ "./ValidationBench"));
const TestDetection         = lazy(() => import(/* webpackChunkName: "test-detection" */ "./TestDetection"));

function PageSkeleton() {
  return (
    <div className="animate-skeleton-pulse h-[80vh] w-full rounded-2xl border border-white/5" />
  );
}

class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true };
  }
  componentDidCatch(error) {
    // If it's a dynamic import failure (chunk deleted after deployment)
    if (error?.message?.includes("Failed to fetch dynamically imported module") || 
        error?.message?.includes("Importing a module script failed")) {
      console.warn("Chunk load error detected. Reloading page to fetch new bundles...");
      window.location.reload();
    }
  }
  render() {
    if (this.state.hasError) {
      return <PageSkeleton />; // Show skeleton while reloading
    }
    return this.props.children;
  }
}

function PagesContent() {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/validate-audio" element={
          <Layout currentPageName="Validate Audio">
            <ValidationBench />
          </Layout>
        } />

        <Route path="/test-detection" element={
          <Layout currentPageName="Test Detection">
            <TestDetection />
          </Layout>
        } />

        <Route path="/subscribe" element={
          <Layout currentPageName="Subscription">
            <SubscriptionPage />
          </Layout>
        } />

        {/* ── Fully implemented routes ─────────────────────────────────── */}
        <Route path="/ai-updates" element={
          <Layout currentPageName="Latest AI Updates">
            <AIUpdates />
          </Layout>
        } />

        <Route path="/trips" element={
          <Layout currentPageName="My Trips">
            <Trips />
          </Layout>
        } />

        <Route path="/settings" element={
          <Layout currentPageName="Settings">
            <Settings />
          </Layout>
        } />

        {/* ── Coming Soon routes ───────────────────────────────────────── */}
        <Route path="/bookings" element={
          <Layout currentPageName="Bookings">
            <ComingSoon featureName="Bookings" />
          </Layout>
        } />

        <Route path="/saved" element={
          <Layout currentPageName="Saved">
            <ComingSoon featureName="Saved Vehicles" />
          </Layout>
        } />

        <Route path="/payments" element={
          <Layout currentPageName="Payments">
            <ComingSoon featureName="Payments" />
          </Layout>
        } />

        {/* Legacy path — redirect to ai-updates */}
        <Route path="/carops" element={
          <Layout currentPageName="Latest AI Updates">
            <AIUpdates />
          </Layout>
        } />

        {/* ── Default / Dashboard ──────────────────────────────────────── */}
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
    </ChunkErrorBoundary>
  );
}

export default function Pages() {
  return (
    <Router basename={import.meta.env.BASE_URL}>
      <PagesContent />
    </Router>
  );
}
