import { BrowserRouter, Routes, Route, useSearchParams } from 'react-router-dom';

// Pages & Layouts
import { LandingPage } from './pages/LandingPage';
import { DemoLayout } from './pages/DemoLayout';

const Main = () => {
  const [searchParams] = useSearchParams();
  const demoId = searchParams.get('demo');

  if (demoId) {
    return <DemoLayout demoId={demoId} />;
  }

  return <LandingPage />;
};

function App() {
  return (
    <BrowserRouter basename="/gran-prix/">
      <Routes>
        <Route path="*" element={<Main />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
