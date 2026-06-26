import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import browser from 'webextension-polyfill';
import { saveDiagramImage } from './utils/video/frame-store';

function App() {
	const [initialData, setInitialData] = useState<any>(null);
	const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
	const [isReady, setIsReady] = useState(false);
	
	const diagramId = new URLSearchParams(window.location.search).get('id');

	useEffect(() => {
		if (diagramId) {
			browser.storage.local.get('diagrams').then(res => {
				const diagrams = (res.diagrams || {}) as Record<string, any>;
				const d = diagrams[diagramId];
				if (d && d.sceneData) {
					setInitialData(d.sceneData);
				}
				setIsReady(true);
			});
		}
	}, [diagramId]);

	const save = async () => {
		if (!excalidrawAPI || !diagramId) return;
		
		const elements = excalidrawAPI.getSceneElements();
		const appState = excalidrawAPI.getAppState();
		const files = excalidrawAPI.getFiles();
		
		const blob = await exportToBlob({
			elements,
			appState,
			files,
			mimeType: 'image/png',
		});
		
		const reader = new FileReader();
		reader.onloadend = async () => {
			const dataUrl = reader.result as string;
			const sceneData = { elements, appState: { viewBackgroundColor: appState.viewBackgroundColor }, files };

			// The rendered PNG goes to the IndexedDB blob store (keyed by diagram id);
			// storage.local keeps only the editable scene + a timestamp. This keeps the
			// image out of every JSON payload (storage + sync) — see frame-store.
			await saveDiagramImage(diagramId, dataUrl);
			const res = await browser.storage.local.get('diagrams');
			const diagrams = (res.diagrams || {}) as Record<string, any>;
			diagrams[diagramId] = {
				sceneData,
				updatedAt: Date.now()
			};

			await browser.storage.local.set({ diagrams });
			window.close();
		};
		reader.readAsDataURL(blob);
	};

	if (!isReady) return null;

	return (
		<>
			<div className="top-bar">
				<button onClick={save}>Save & Close</button>
			</div>
			<div style={{ height: '100%' }}>
				<Excalidraw 
					initialData={initialData}
					excalidrawAPI={(api: any) => setExcalidrawAPI(api)} 
				/>
			</div>
		</>
	);
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
