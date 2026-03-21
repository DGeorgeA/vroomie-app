import { useEffect } from "react";
import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
import { initializeAudioDataset } from "@/services/audioDatasetService"

function App() {

  useEffect(() => {
    // App initialization
    initializeAudioDataset().catch(console.error);
  }, []); // run once when the app loads

  return (
    <>
      <Pages />
      <Toaster />
    </>
  );
}

export default App;

