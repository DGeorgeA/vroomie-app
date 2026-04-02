import React from "react";
import { motion } from "framer-motion";
import Hero from "../components/landing/Hero";
import FeatureCard from "../components/landing/FeatureCard";
import { Activity, Droplets, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function Landing() {
  const features = [
    {
      title: "Predictive Maintenance",
      description: "AI-powered engine sound analysis detects issues before they become expensive problems. Real-time audio monitoring with ECG-style visualization.",
      icon: Activity,
      accentColor: "yellow",
      pagePath: "PredictiveMaintenance",
      features: [
        "Live audio waveform monitoring",
        "Anomaly detection with high accuracy",
        "Mechanic report generation",
        "Early warning system",
        "Historical analysis tracking",
      ],
    },
    {
      title: "CarOps Control",
      description: "Remote vehicle control at your fingertips. Pre-cool your car, start the engine, and activate security features from anywhere.",
      icon: Droplets,
      accentColor: "blue",
      pagePath: "CarOps",
      features: [
        "Climate pre-conditioning",
        "Remote engine start/stop",
        "Dash cam activation",
        "Integration with Smartcar & OEM APIs",
        "Real-time status monitoring",
      ],
    },
    {
      title: "AR Detailing Marketplace",
      description: "Visualize car modifications before you commit. Browse detailing services, preview AR overlays, and book appointments with verified shops.",
      icon: Sparkles,
      accentColor: "green",
      pagePath: "DetailingMarketplace",
      features: [
        "AR overlay preview studio",
        "Verified detailing shops",
        "Instant price comparison",
        "Before/after visualization",
        "One-click booking",
      ],
    },
  ];

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <Hero />

      {/* Features Section */}
      <section className="relative py-20 md:py-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-14 text-center">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="text-3xl md:text-5xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-yellow-300 bg-clip-text text-transparent">
                Three Powerful Modules
              </span>
            </h2>
            <p className="text-base md:text-lg text-zinc-400 max-w-xl mx-auto">
              Everything you need to maintain, control, and enhance your vehicle
            </p>
          </motion.div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, index) => (
              <FeatureCard key={feature.title} {...feature} index={index} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="relative py-16 md:py-24">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="relative bg-zinc-900/80 border border-yellow-300/20 rounded-2xl p-10 md:p-14 text-center"
          >
            <h2 className="text-2xl md:text-4xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-yellow-300 bg-clip-text text-transparent">
                Ready to Transform Your Car Care?
              </span>
            </h2>
            <p className="text-zinc-400 mb-8 max-w-lg mx-auto">
              Join thousands of drivers using AI to save money, time, and hassle.
            </p>
            <Link
              to={createPageUrl("PredictiveMaintenance")}
              className="inline-flex items-center gap-2 px-8 py-3.5 bg-yellow-400 text-black rounded-lg font-semibold text-sm hover:bg-yellow-300 transition-colors"
            >
              Get Started Free
            </Link>
          </motion.div>
        </div>
      </section>
    </div>
  );
}