import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// Pages & Layouts
import { LandingPage } from './pages/LandingPage';
import { DemoLayout } from './pages/DemoLayout';

// Demos
import { OvenDemo } from './components/oven';
import { VacuumDemo } from './components/vacuum';
import { TraderDemo } from './components/trader';
import { SmartGridDemo } from './components/smart-grid';
import { DroneDemo } from './components/drone';
import { PredatorPreyDemo } from './components/predator-prey';
import { WalkerDemo } from './components/walker';
import { FlappyDemo } from './components/flappy';

// The original Evolution + Backprop (Training) demos require more global state right now.
// For the sake of this architectural migration, we wrap them in a simple local component or redirect them.
// The user asked to structure the *examples* into dedicated pages.
// We will focus on the main isolated examples first.

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Landing Page with Hero and Grid */}
        <Route path="/" element={<LandingPage />} />

        {/* Dedicated Demo Routes wrapped in standard Layout */}
        <Route element={<DemoLayout />}>
          <Route path="/demo/oven" element={<div className="w-full flex justify-center py-8"><OvenDemo /></div>} />
          <Route path="/demo/vacuum" element={<div className="w-full flex justify-center py-8"><VacuumDemo /></div>} />
          <Route path="/demo/trader" element={<div className="w-full flex justify-center py-8"><TraderDemo /></div>} />
          <Route path="/demo/smart-grid" element={<div className="w-full flex justify-center py-8"><SmartGridDemo /></div>} />
          <Route path="/demo/drone" element={<div className="w-full flex justify-center py-8"><DroneDemo /></div>} />
          <Route path="/demo/predator-prey" element={<div className="w-full flex justify-center py-8"><PredatorPreyDemo /></div>} />
          <Route path="/demo/walker" element={<div className="w-full flex justify-center py-8"><WalkerDemo /></div>} />
          <Route path="/demo/flappy" element={<div className="w-full flex justify-center py-8"><FlappyDemo /></div>} />

          {/* Fallbacks for older demos until fully isolated */}
          <Route path="/demo/evolution" element={<div className="w-full text-center py-24 text-muted-foreground uppercase tracking-widest text-sm">Car Evolution isolamento em breve</div>} />
          <Route path="/demo/training" element={<div className="w-full text-center py-24 text-muted-foreground uppercase tracking-widest text-sm">Backprop isolamento em breve</div>} />

          {/* Catch-all to redirect back home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
