import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw } from '@excalidraw/excalidraw';
import * as Icons from './excalidraw-icons';

function App() {
	const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
	const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
	const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
	// Bumped on every INIT_FRAME so the scene-setup effect re-runs even when the
	// captured frame is byte-identical to the last one (recapturing the SAME paused
	// timestamp yields the same dataURL — React would otherwise bail on the
	// unchanged state and never re-post FRAME_RENDERED, leaving the host to reveal
	// the iframe only via its slow 700ms fallback).
	const [initSeq, setInitSeq] = useState(0);
	
	const [appState, setAppState] = useState<any>({
		activeTool: { type: 'freedraw' },
		currentItemStrokeColor: '#ffeb3b',
		currentItemBackgroundColor: 'transparent',
		currentItemStrokeWidth: 1,
		currentItemStrokeStyle: 'solid',
		currentItemRoughness: 1,
		currentItemRoundness: 'sharp',
		currentItemFillStyle: 'hachure'
	});
	const [selectedElements, setSelectedElements] = useState<any[]>([]);
	const [activePopup, setActivePopup] = useState<string | null>(null);
	const [tempSelectedValue, setTempSelectedValue] = useState<any>(null);
	const [activeToolType, setActiveToolType] = useState<string>('selection');
	
	// Vertical bands (px) reserved at the top/bottom of the iframe for the native
	// toolbar and our properties bar — the captured frame is fit into the region
	// between them so nothing overlaps the drawing.
	const TOP_BAND = 40;
	const BOTTOM_BAND = 40;

	useEffect(() => {
		const handleMessage = (e: MessageEvent) => {
			if (e.data?.type === 'INIT_FRAME') {
				setFrameDataUrl(e.data.dataUrl);
				setFrameSize({ w: e.data.w, h: e.data.h });
				setInitSeq(s => s + 1);
			} else if (e.data?.type === 'TRIGGER_SAVE') {
				save('save');
			} else if (e.data?.type === 'TRIGGER_COMMENT') {
				save('comment');
			} else if (e.data?.type === 'TRIGGER_DISCARD') {
				discard();
			}
		};
		window.addEventListener('message', handleMessage);
		window.parent.postMessage({ type: 'EXCALIDRAW_READY' }, '*');
		return () => window.removeEventListener('message', handleMessage);
	}, [excalidrawAPI]);

	useEffect(() => {
		if (!excalidrawAPI || !frameDataUrl) return;
		try {
		const fileId = 'frame-img-' + Date.now();

		// Reset any prior scene first — the iframe is pooled and reused across
		// captures, so we must clear the previous frame + drawings.
		excalidrawAPI.updateScene({ elements: [] });

		// The captured JPEG is already a dataURL: hand it straight to Excalidraw,
		// no fetch→blob→FileReader round-trip.
		excalidrawAPI.addFiles([{
			id: fileId, dataURL: frameDataUrl, mimeType: 'image/jpeg',
			created: Date.now(), lastRetrieved: Date.now()
		}]);

		const elements = [{
			type: 'image', version: 1, versionNonce: Date.now(), isDeleted: false,
			id: 'bg-image', fillStyle: 'hachure', strokeWidth: 1, strokeStyle: 'solid',
			roughness: 1, opacity: 100, angle: 0, x: 0, y: 0,
			width: frameSize.w, height: frameSize.h, seed: 1, groupIds: [],
			frameId: null, roundness: null, boundElements: [], updated: Date.now(),
			link: null, locked: true, fileId: fileId, scale: [1, 1]
		}];

		// Place the frame deterministically (no fitToViewport, which pads/scales
		// unpredictably): fit it into the region between the top/bottom bands and
		// lock zoom+scroll so scene units map 1:1 onto the visible picture.
		const W = window.innerWidth, H = window.innerHeight;
		const regionH = Math.max(1, H - TOP_BAND - BOTTOM_BAND);
		const zoom = Math.min(W / frameSize.w, regionH / frameSize.h);
		const dispW = frameSize.w * zoom, dispH = frameSize.h * zoom;
		const offX = (W - dispW) / 2;
		const offY = TOP_BAND + (regionH - dispH) / 2;

		excalidrawAPI.updateScene({
			elements,
			appState: { zoom: { value: zoom }, scrollX: offX / zoom, scrollY: offY / zoom }
		});
		excalidrawAPI.setActiveTool({ type: 'freedraw' });

		// Tell the host the scene is set so it can reveal the iframe. Post
		// immediately — the iframe is visibility:hidden while off-screen, and Chrome
		// throttles requestAnimationFrame there, so a rAF-gated signal can never
		// arrive. The scene is already applied synchronously above, so the first
		// paint after the host flips visibility will show content.
		window.parent.postMessage({ type: 'FRAME_RENDERED' }, '*');
		} catch (err) {
			console.error('[vid-excali] image setup failed', err);
			window.parent.postMessage({ type: 'FRAME_RENDERED' }, '*');
		}
	}, [excalidrawAPI, frameDataUrl, initSeq]);

	const cycleProp = (key: string, optionsList: any[]) => {
		if (!excalidrawAPI) return;
		const state = excalidrawAPI.getAppState();
		const current = activePopup === key ? tempSelectedValue : state[key];
		let currentIndex = optionsList.findIndex(o => {
			if (key === 'currentItemRoundness') {
				const val = current === null ? 'sharp' : current?.type === 2 ? 'round' : 'elbow';
				return o.val === val;
			}
			return o.val === current || o.value === current;
		});
		if (currentIndex === -1) currentIndex = 0;
		const nextIndex = (currentIndex + 1) % optionsList.length;
		
		setActivePopup(key);
		setTempSelectedValue(optionsList[nextIndex].val ?? optionsList[nextIndex].value);
	};

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.getAttribute('contenteditable') === 'true') {
				if (e.key === 'Escape') return;
				return;
			}
			const k = e.key.toLowerCase();
			if (e.key === 'Enter') { 
				e.preventDefault(); e.stopPropagation(); 
				if (activePopup) {
					updateProp(activePopup, tempSelectedValue);
					setActivePopup(null);
				} else {
					save('save'); 
				}
			}
			else if (e.key === 'Escape') { 
				e.preventDefault(); e.stopPropagation(); 
				if (activePopup) {
					setActivePopup(null);
				} else {
					discard(); 
				}
			}
			else if (k === 'c' || k === 'n') { 
				if (activePopup) return;
				e.preventDefault(); e.stopPropagation(); 
				save('comment'); 
			}
			else if (k === 's') { e.preventDefault(); e.stopPropagation(); cycleProp('currentItemStrokeColor', colors); }
			else if (k === 'g') { e.preventDefault(); e.stopPropagation(); cycleProp('currentItemBackgroundColor', colors); }
			else if (k === 'f') { e.preventDefault(); e.stopPropagation(); cycleProp('currentItemFillStyle', fillStyles); }
			else if (k === 'w') { e.preventDefault(); e.stopPropagation(); cycleProp('currentItemStrokeWidth', strokeWidths); }
			else if (k === 'x') { e.preventDefault(); e.stopPropagation(); cycleProp('currentItemStrokeStyle', strokeStyles); }
			else if (k === 'q') { e.preventDefault(); e.stopPropagation(); cycleProp('currentItemOpacity', opacities); }
		};
		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [excalidrawAPI, activePopup, tempSelectedValue]);

	const save = async (action: 'save' | 'comment') => {
		if (!excalidrawAPI) return;
		const elements = excalidrawAPI.getSceneElements();
		const state = excalidrawAPI.getAppState();
		const files = excalidrawAPI.getFiles();
		
		try {
			const { exportToBlob } = await import('@excalidraw/excalidraw');
			const blob = await exportToBlob({
				elements,
				mimeType: 'image/jpeg',
				appState: { ...state, exportBackground: true },
				files
			});
			
			const reader = new FileReader();
			reader.onloadend = () => {
				const bakedDataUrl = reader.result;
				window.parent.postMessage({ 
					type: 'SAVE_ANNOTATION', 
					action, 
					sceneData: { 
						elements, 
						appState: { viewBackgroundColor: state.viewBackgroundColor }, 
						files,
						bakedDataUrl
					} 
				}, '*');
			};
			reader.readAsDataURL(blob as Blob);
		} catch (e) {
			console.error("Failed to export Excalidraw scene to blob:", e);
			window.parent.postMessage({ type: 'SAVE_ANNOTATION', action, sceneData: { elements, appState: { viewBackgroundColor: state.viewBackgroundColor }, files } }, '*');
		}
	};

	const discard = () => {
		window.parent.postMessage({ type: 'DISCARD_ANNOTATION' }, '*');
	};



	const handleExcalidrawChange = (elements: readonly any[], state: any) => {
		const trackedStateKeys = [
			'currentItemStrokeColor', 'currentItemBackgroundColor',
			'currentItemFillStyle', 'currentItemStrokeWidth', 'currentItemStrokeStyle',
			'currentItemRoughness', 'currentItemOpacity', 'currentItemFontFamily',
			'currentItemFontSize', 'currentItemTextAlign', 'currentItemStartArrowhead',
			'currentItemEndArrowhead', 'currentItemRoundness'
		];

		let stateChanged = false;
		for (const key of trackedStateKeys) {
			if (state[key] !== appState[key]) {
				if (JSON.stringify(state[key]) !== JSON.stringify(appState[key])) {
					stateChanged = true;
					break;
				}
			}
		}

		if (state.activeTool?.type !== appState.activeTool?.type) stateChanged = true;
		if (state.editingElement?.id !== appState.editingElement?.id) stateChanged = true;
		
		const currentSelectedIds = Object.keys(appState.selectedElementIds || {}).join(',');
		const newSelectedIds = Object.keys(state.selectedElementIds || {}).join(',');
		if (currentSelectedIds !== newSelectedIds) stateChanged = true;

		if (stateChanged) {
			const nextAppState = {
				...state,
				activeTool: { ...state.activeTool },
				editingElement: state.editingElement ? { id: state.editingElement.id, type: state.editingElement.type } : null,
				selectedElementIds: { ...state.selectedElementIds }
			};
			setAppState(nextAppState);
			
			let tool = state.activeTool?.type || 'selection';
			if (state.editingElement) {
				tool = state.editingElement.type;
			} else if (tool === 'selection' && state.selectedElementIds) {
				const selected = elements.filter((el: any) => state.selectedElementIds[el.id]);
				if (selected.length > 0) {
					tool = selected[0].type;
				}
				setSelectedElements(selected);
			} else {
				setSelectedElements([]);
			}
			setActiveToolType(tool);
		}
	};

	const updateProp = (key: string, value: any) => {
		if (!excalidrawAPI) return;
		excalidrawAPI.updateScene({ appState: { [key]: value } });
		
		const state = excalidrawAPI.getAppState();
		const elements = excalidrawAPI.getSceneElements();
		const selected = elements.filter((el: any) => state.selectedElementIds[el.id]);
		if (selected.length) {
			const updated = selected.map((el: any) => {
				const newEl = { ...el };
				if (key === 'currentItemStrokeColor') newEl.strokeColor = value;
				if (key === 'currentItemBackgroundColor') newEl.backgroundColor = value;
				if (key === 'currentItemStrokeWidth') newEl.strokeWidth = value;
				if (key === 'currentItemStrokeStyle') newEl.strokeStyle = value;
				if (key === 'currentItemRoughness') newEl.roughness = value;
				if (key === 'currentItemRoundness') {
					if (newEl.type === 'arrow') {
						newEl.roundness = value === 'sharp' ? null : value === 'round' ? { type: 2 } : { type: 3 }; // 2 is round, 3 is elbow roughly
					} else {
						newEl.roundness = value === 'round' ? { type: 3 } : null; // adaptive radius
					}
				}
				if (key === 'currentItemFillStyle') newEl.fillStyle = value;
				if (key === 'currentItemFontFamily') newEl.fontFamily = value;
				if (key === 'currentItemFontSize') newEl.fontSize = value;
				if (key === 'currentItemTextAlign') newEl.textAlign = value;
				if (key === 'currentItemStartArrowhead') newEl.startArrowhead = value;
				if (key === 'currentItemEndArrowhead') newEl.endArrowhead = value;
				if (key === 'currentItemOpacity') newEl.opacity = value;
				return newEl;
			});
			const otherElements = elements.filter((el: any) => !state.selectedElementIds[el.id]);
			excalidrawAPI.updateScene({ elements: [...otherElements, ...updated] });
		}
	};

	const isShape = ['rectangle', 'diamond', 'ellipse'].includes(activeToolType);
	const isRectangle = activeToolType === 'rectangle';
	const isDiamond = activeToolType === 'diamond';
	const isEllipse = activeToolType === 'ellipse';
	const isLine = activeToolType === 'line';
	const isArrow = activeToolType === 'arrow';
	const isFreedraw = activeToolType === 'freedraw';
	const isText = activeToolType === 'text';

	// The icons for properties
	const strokeWidths = [
		{ val: 1, icon: <Icons.StrokeWidthBaseIcon /> },
		{ val: 2, icon: <Icons.StrokeWidthBoldIcon /> },
		{ val: 4, icon: <Icons.StrokeWidthExtraBoldIcon /> }
	];
	const strokeStyles = [
		{ val: 'solid', icon: <Icons.StrokeStyleSolidIcon /> },
		{ val: 'dashed', icon: <Icons.StrokeStyleDashedIcon /> },
		{ val: 'dotted', icon: <Icons.StrokeStyleDottedIcon /> }
	];
	const roughnesses = [
		{ val: 0, icon: <Icons.SloppinessArchitectIcon /> },
		{ val: 1, icon: <Icons.SloppinessArtistIcon /> },
		{ val: 2, icon: <Icons.SloppinessCartoonistIcon /> }
	];
	const roundnesses = [
		{ val: 'sharp', icon: <Icons.EdgeSharpIcon /> },
		{ val: 'round', icon: <Icons.EdgeRoundIcon /> }
	];
	const fillStyles = [
		{ val: 'hachure', icon: <Icons.FillHachureIcon /> },
		{ val: 'cross-hatch', icon: <Icons.FillCrossHatchIcon /> },
		{ val: 'solid', icon: <Icons.FillSolidIcon /> }
	];
	
	const fontFamilies = [
		{ val: 1, icon: <Icons.FontFamilyHeadingIcon /> },
		{ val: 2, icon: <Icons.FontFamilyNormalIcon /> },
		{ val: 3, icon: <Icons.FontFamilyCodeIcon /> }
	];
	const fontSizes = [
		{ val: 16, icon: <Icons.FontSizeSmallIcon /> },
		{ val: 20, icon: <Icons.FontSizeMediumIcon /> },
		{ val: 28, icon: <Icons.FontSizeLargeIcon /> },
		{ val: 36, icon: <Icons.FontSizeExtraLargeIcon /> }
	];
	const textAligns = [
		{ val: 'left', icon: <Icons.TextAlignLeftIcon /> },
		{ val: 'center', icon: <Icons.TextAlignCenterIcon /> },
		{ val: 'right', icon: <Icons.TextAlignRightIcon /> }
	];
	const arrowheads = [
		{ val: null, icon: <Icons.ArrowheadNoneIcon /> },
		{ val: 'arrow', icon: <Icons.ArrowheadArrowIcon /> },
		{ val: 'triangle', icon: <Icons.ArrowheadTriangleIcon /> },
		{ val: 'dot', icon: <Icons.ArrowheadCircleIcon /> },
		{ val: 'bar', icon: <Icons.ArrowheadBarIcon /> }
	];
	const arrowTypes = [
		{ val: 'sharp', icon: <Icons.sharpArrowIcon /> },
		{ val: 'round', icon: <Icons.roundArrowIcon /> },
		{ val: 'elbow', icon: <Icons.elbowArrowIcon /> }
	];
	const opacities = [
		{ val: 100, icon: <span style={{fontSize:'12px', fontWeight:'bold'}}>100%</span> },
		{ val: 75, icon: <span style={{fontSize:'12px', fontWeight:'bold'}}>75%</span> },
		{ val: 50, icon: <span style={{fontSize:'12px', fontWeight:'bold'}}>50%</span> },
		{ val: 25, icon: <span style={{fontSize:'12px', fontWeight:'bold'}}>25%</span> }
	];

	const colors = [
		{ name: 'yellow', val: '#ffeb3b' }, { name: 'orange', val: '#ff9800' }, { name: 'red', val: '#f44336' }, 
		{ name: 'green', val: '#4caf50' }, { name: 'blue', val: '#2196f3' }, { name: 'black', val: '#000000' }, { name: 'white', val: '#ffffff' }
	];

	// Components
	const OptionGroup = ({ options, currentVal, propKey, isColor = false }: any) => {
		const isCurrentlyActive = (o: any) => {
			if (o.val === currentVal) return true;
			// Excalidraw sometimes normalizes 'sharp' or 'none' to null or undefined
			if ((o.val === 'sharp' || o.val === null || o.val === 'none') && (currentVal === null || currentVal === undefined || currentVal === 'sharp' || currentVal === 'none')) {
				// Only match if the option is actually sharp or none, and currentVal is falsy or equivalent
				if (o.val === 'sharp' && (currentVal === 'sharp' || currentVal === null || currentVal === undefined)) return true;
				if ((o.val === null || o.val === 'none') && (currentVal === 'none' || currentVal === null || currentVal === undefined)) return true;
			}
			return false;
		};

		const selected = options.find(isCurrentlyActive) || options[0];
		const isPopupOpen = activePopup === propKey;

		return (
			<div className="option-group" style={isPopupOpen ? { zIndex: 100 } : undefined}>
				<div className="option-popup" style={isPopupOpen ? { display: 'flex' } : undefined}>
					<div className="option-popup-inner">
						{options.map((o: any) => {
							const isTempActive = isPopupOpen && (o.val === tempSelectedValue || o.value === tempSelectedValue);
							return (
								<div key={String(o.val)} 
									className={`${isColor ? 'color-swatch' : 'option-btn'} ${isCurrentlyActive(o) && !isTempActive ? 'active' : ''}`}
									style={{
										...(isColor ? { background: o.val === 'transparent' ? 'transparent' : o.val } : {}),
										...(isTempActive ? { outline: '2px solid white', outlineOffset: '2px', zIndex: 10 } : {})
									}}
									onClick={() => {
										updateProp(propKey, o.val);
										setActivePopup(null);
									}}
									title={isColor ? o.name : ''}
								>
									{!isColor && o.icon}
								</div>
							);
						})}
					</div>
				</div>
				<div className={`${isColor ? 'color-swatch' : 'option-btn'} active`} style={isColor ? { background: selected.val === 'transparent' ? 'transparent' : selected.val } : {}}>
					{!isColor && selected.icon}
				</div>
			</div>
		);
	};

	return (
		<>
			<div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}>
				<Excalidraw 
					excalidrawAPI={(api) => setExcalidrawAPI(api)} 
					onChange={handleExcalidrawChange}
					zenModeEnabled={false}
					viewModeEnabled={false}
					theme="light"
					initialData={{
						appState: {
							currentItemStrokeColor: '#ffeb3b',
							currentItemBackgroundColor: 'transparent',
							viewBackgroundColor: 'transparent'
						}
					}}
				/>
			</div>
			
			{frameDataUrl && <div className="custom-ui">
				<div className="top-right-bar">
					<button className="action-btn secondary" onClick={discard}>Esc Cancel</button>
					<button className="action-btn secondary" onClick={() => save('comment')}>C Comment</button>
					<button className="action-btn" onClick={() => save('save')}>Enter Save</button>
				</div>
				
				{(isShape || isLine || isArrow || isFreedraw || isText) && (
					<div className="bottom-options-bar">
						{/* Stroke Color applies to almost everything */}
						<OptionGroup options={colors} currentVal={appState.currentItemStrokeColor} propKey="currentItemStrokeColor" isColor={true} />
						
						{/* Background Color & Fill apply to shapes, lines, freedraw */}
						{(isShape || isLine || isFreedraw) && (
							<>
								<div style={{width:'1px', height:'20px', background:'rgba(255,255,255,0.2)'}}></div>
								<OptionGroup options={[{name:'transparent', val:'transparent'}, ...colors]} currentVal={appState.currentItemBackgroundColor} propKey="currentItemBackgroundColor" isColor={true} />
								{appState.currentItemBackgroundColor !== 'transparent' && (
									<OptionGroup options={fillStyles} currentVal={appState.currentItemFillStyle} propKey="currentItemFillStyle" />
								)}
							</>
						)}

						{/* Text properties */}
						{isText && (
							<>
								<div style={{width:'1px', height:'20px', background:'rgba(255,255,255,0.2)'}}></div>
								<OptionGroup options={fontFamilies} currentVal={appState.currentItemFontFamily} propKey="currentItemFontFamily" />
								<OptionGroup options={fontSizes} currentVal={appState.currentItemFontSize} propKey="currentItemFontSize" />
								<OptionGroup options={textAligns} currentVal={appState.currentItemTextAlign} propKey="currentItemTextAlign" />
							</>
						)}
						
						{/* Stroke width applies to shapes, lines, arrow, freedraw */}
						{(isShape || isLine || isArrow || isFreedraw) && (
							<>
								<div style={{width:'1px', height:'20px', background:'rgba(255,255,255,0.2)'}}></div>
								<OptionGroup options={strokeWidths} currentVal={appState.currentItemStrokeWidth} propKey="currentItemStrokeWidth" />
							</>
						)}
						
						{/* Stroke style applies to shapes, lines, arrow */}
						{(isShape || isLine || isArrow) && (
							<OptionGroup options={strokeStyles} currentVal={appState.currentItemStrokeStyle} propKey="currentItemStrokeStyle" />
						)}
						
						{/* Sloppiness/Roughness applies to shapes, lines, arrow, freedraw */}
						{(isShape || isLine || isArrow || isFreedraw) && (
							<OptionGroup options={roughnesses} currentVal={appState.currentItemRoughness} propKey="currentItemRoughness" />
						)}
						
						{/* Edges/Roundness applies to rectangles, diamonds, lines */}
						{(isLine || isRectangle || isDiamond) && (
							<OptionGroup options={roundnesses} currentVal={appState.currentItemRoundness === null ? 'sharp' : 'round'} propKey="currentItemRoundness" />
						)}

						{/* Arrow Type (Routing) applies to arrows */}
						{isArrow && (
							<OptionGroup options={arrowTypes} currentVal={appState.currentItemRoundness === null ? 'sharp' : appState.currentItemRoundness?.type === 2 ? 'round' : 'elbow'} propKey="currentItemRoundness" />
						)}

						{/* Arrowheads apply to arrow tool */}
						{isArrow && (
							<>
								<div style={{width:'1px', height:'20px', background:'rgba(255,255,255,0.2)'}}></div>
								<OptionGroup options={arrowheads} currentVal={appState.currentItemStartArrowhead} propKey="currentItemStartArrowhead" />
								<OptionGroup options={arrowheads} currentVal={appState.currentItemEndArrowhead} propKey="currentItemEndArrowhead" />
							</>
						)}

						{/* Opacity applies to everything */}
						<div style={{width:'1px', height:'20px', background:'rgba(255,255,255,0.2)'}}></div>
						<OptionGroup options={opacities} currentVal={appState.currentItemOpacity} propKey="currentItemOpacity" />
					</div>
				)}
			</div>}
		</>
	);
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
