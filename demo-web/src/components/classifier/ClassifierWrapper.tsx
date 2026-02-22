import React, { useEffect, useState } from 'react';
import { useWasmPopulation } from '../../hooks/useWasmPopulation';
import { ClassifierDemo } from './ClassifierDemo';

export const ClassifierWrapper: React.FC = () => {
    const { population, initWasm } = useWasmPopulation();
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        if (!population) {
            initWasm().then(() => setIsReady(true)).catch(console.error);
        } else {
            setIsReady(true);
        }
    }, [initWasm, population]);

    return (
        <div className="w-full flex justify-center py-12">
            <ClassifierDemo isWasmReady={isReady} />
        </div>
    );
};
