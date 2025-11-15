import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
import { maybeRedirectToBase44Login } from './api/base44Client';
maybeRedirectToBase44Login();
function App() {
  return (
    <>
      <Pages />
      <Toaster />
    </>
  )
}

export default App 
