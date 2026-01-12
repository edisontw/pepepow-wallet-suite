import "./theme.css";
import "./styles/ui.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import WalletHome from "./pages/WalletHome";
import Send from "./pages/Send";
import History from "./pages/History";
import Mini from "./pages/Mini";
import Pay from "./pages/Pay";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<WalletHome />} />
        <Route path="/send" element={<Send />} />
        <Route path="/history" element={<History />} />
        <Route path="/mini" element={<Mini />} />
        <Route path="/pay/:token" element={<Pay />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}
