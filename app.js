/**
 * WashFlow Pro - Multi-Machine Execution System
 */

class WashFlowApp {
    constructor() {
        // Initialize Supabase Client
        const SUPABASE_URL = 'https://alpknaptyjawltrwfnsv.supabase.co';
        const SUPABASE_KEY = 'sb_publishable_5SD3K17m0y3YqzISexp69Q_vhON9UeZ';
        this.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

        this.queue = [];
        this.orders = {}; // Stores { ORD-1234: { id, client, totalSubloads, finishedSubloads } }
        this.jobCounter = 1;
        this.subloadCounter = 1;

        // Machine State (1 = Washer 1, 2 = Washer 2... etc)
        // job: null means free. Otherwise holds job object.
        this.washers = {
            1: { type: 'washer', id: 1, job: null, timeRemaining: 0, interval: null },
            2: { type: 'washer', id: 2, job: null, timeRemaining: 0, interval: null },
            3: { type: 'washer', id: 3, job: null, timeRemaining: 0, interval: null }
        };
        this.dryers = {
            1: { type: 'dryer', id: 1, job: null, timeRemaining: 0, interval: null },
            2: { type: 'dryer', id: 2, job: null, timeRemaining: 0, interval: null },
            3: { type: 'dryer', id: 3, job: null, timeRemaining: 0, interval: null }
        };

        // Time Dictionary Base (Wash, Dry) in minutes
        this.timeDb = {
            'color': { w: 50, d: 45 },
            'blanca': { w: 55, d: 50 },
            'oscura': { w: 50, d: 45 },
            'delicada': { w: 40, d: 30 },
            'pesada': { w: 90, d: 90 },
            'edredones': { w: 100, d: 100 }
        };

        // Modal State
        this.activeJobId = null;
        this.activeTargetType = null; // 'washer' or 'dryer'
        this.sourceMachId = null;
        this.sourceMachType = null;
        
        // Edit Modal State
        this.editMachId = null;
        this.editMachType = null;

        this.initDOM();
        this.startGlobalClock();
        
        // Start from memory while Cloud loads, then fetch Cloud
        this.loadStateLocal();
        this.initCloudSync();
    }

    // --- CLOUD & STATE PERSISTENCE ---

    async initCloudSync() {
        console.log('⚡ Iniciando sincronización de nube...');
        await this.loadFromCloud();

        // Subscribe to real-time changes from other devices (like your phone)
        this.supabase
            .channel('public:app_state')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_state' }, payload => {
                console.log('🔄 Data updated from another device!', payload.new);
                this.applyState(payload.new.state);
            })
            .subscribe((status) => {
                console.log('📡 Supabase WebSocket status:', status);
            });
    }

    async saveState() {
        console.log('💾 Intento de guardado en state...');
        const state = this.createStateObject();
        // Save local fallback
        localStorage.setItem('washflow_state', JSON.stringify(state));
        console.log('✅ LocalStorage guardado con éxito.');

        // Save to Supabase Cloud
        try {
            console.log('⬆️ Subiendo JSON a Supabase...', state);
            const { error } = await this.supabase.from('app_state').upsert({ id: 1, state: state });
            if (error) {
                console.error('❌ Error de Supabase al escribir data:', error);
                alert("Error crítico conectando a la Nube Supabase. Revisa consola.");
            } else {
                console.log('✅ Supabase actualizado con éxito.');
            }
        } catch(e) { 
            console.error('❌ Cloud save falló con Excepción:', e); 
        }
    }

    createStateObject() {
        // Strip out the interval timers from machines before saving
        const safeWashers = JSON.parse(JSON.stringify(this.washers));
        const safeDryers = JSON.parse(JSON.stringify(this.dryers));
        
        for(let i=1; i<=3; i++) {
            delete safeWashers[i].interval;
            delete safeDryers[i].interval;
        }

        return {
            queue: this.queue,
            orders: this.orders,
            jobCounter: this.jobCounter,
            subloadCounter: this.subloadCounter,
            washers: safeWashers,
            dryers: safeDryers,
            saveTime: Date.now()
        };
    }

    loadStateLocal() {
        const saved = localStorage.getItem('washflow_state');
        if(saved) {
            this.applyState(JSON.parse(saved));
        } else {
            // Force first render even if no data
            this.updateQueueBoard();
            this.renderMachines();
            this.renderFoldingBoard();
        }
    }

    async loadFromCloud() {
        try {
            const { data, error } = await this.supabase.from('app_state').select('state').eq('id', 1).single();
            if(data && data.state) {
                console.log('☁️ Loaded state from cloud');
                this.applyState(data.state);
            }
        } catch(e) { console.error('Cloud load failed', e); }
    }

    applyState(state) {
        try {
            // First clear all existing intervals to avoid double-ticks when external updates arrive
            for(let i=1; i<=3; i++) {
                if(this.washers[i] && this.washers[i].interval) clearInterval(this.washers[i].interval);
                if(this.dryers[i] && this.dryers[i].interval) clearInterval(this.dryers[i].interval);
            }

            this.queue = state.queue || [];
            this.orders = state.orders || {};
            this.jobCounter = state.jobCounter || 1;
            this.subloadCounter = state.subloadCounter || 1;
            
            // Calculate time elapsed since last save to deduct from timers
            const elapsedMins = state.saveTime ? Math.floor((Date.now() - state.saveTime) / 60000) : 0;

            // Restore Washers
            if(state.washers) {
                for(let i=1; i<=3; i++) {
                    const w = state.washers[i];
                    this.washers[i] = w;
                    if(w.job) {
                        // Deduct elapsed time only if NOT paused
                        w.timeRemaining = w.job.isPaused ? w.timeRemaining : Math.max(0, w.timeRemaining - Math.floor((Date.now() - state.saveTime) / 60000));
                        // Restart interval
                        this.washers[i].interval = setInterval(() => {
                            if(!this.washers[i].job.isPaused && this.washers[i].timeRemaining > 0) {
                                this.washers[i].timeRemaining--;
                                this.renderMachines();
                                this.saveState();
                            }
                        }, 60000);
                    }
                }
            }

            // Restore Dryers
            if(state.dryers) {
                for(let i=1; i<=3; i++) {
                    const d = state.dryers[i];
                    this.dryers[i] = d;
                    if(d.job) {
                        this.dryers[i].timeRemaining = d.job.isPaused ? d.timeRemaining : Math.max(0, d.timeRemaining - Math.floor((Date.now() - state.saveTime) / 60000));
                        this.dryers[i].interval = setInterval(() => {
                            if(!this.dryers[i].job.isPaused && this.dryers[i].timeRemaining > 0) {
                                this.dryers[i].timeRemaining--;
                                this.renderMachines();
                                this.saveState();
                            }
                        }, 60000);
                    }
                }
            }

            // Re-render UI
            this.updateQueueBoard();
            this.renderMachines();
            this.renderFoldingBoard();
            
        } catch (e) {
            console.error("Failed to load state", e);
        }
    }

    initDOM() {
        document.getElementById('add-subload-btn').addEventListener('click', () => this.addSubloadForm());
        document.getElementById('submit-client-btn').addEventListener('click', () => this.processClientForm());
    }

    startGlobalClock() {
        const clockEl = document.getElementById('global-clock');
        setInterval(() => {
            const now = new Date();
            clockEl.textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        }, 1000);
    }

    // --- FORM LOGIC ---

    addSubloadForm() {
        this.subloadCounter++;
        const wrapper = document.getElementById('subloads-wrapper');
        const index = wrapper.children.length;
        
        const html = `
            <div class="subload-card" data-index="${index}">
                <div class="subload-header">
                    <h4>Carga ${index + 1}</h4>
                    <button class="remove-subload" onclick="this.closest('.subload-card').remove(); app.calculateOrderETA()"><i class="ph ph-trash"></i></button>
                </div>
                <div class="form-group">
                    <label>Tipo de Tela</label>
                    <select class="fabric-type" onchange="app.estimateTimes(this)">
                        <option value="color">De Color</option>
                        <option value="blanca">Blanca</option>
                        <option value="oscura">Oscura</option>
                        <option value="delicada">Delicada</option>
                        <option value="pesada">Pesada</option>
                        <option value="edredones">Edredones/Cobijas</option>
                    </select>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Peso (lbs)</label>
                        <input type="number" class="weight-input" min="1" value="10" oninput="app.estimateTimes(this)">
                        <span style="font-size:0.65rem; color:var(--text-muted); display:block; margin-top:0.2rem;">Máx 25lb por máquina (Autodivisión a 20lb)</span>
                    </div>
                    <div class="form-group">
                        <label>Urgencia</label>
                        <select class="urgency-select">
                            <option value="1" selected>No urgente</option>
                            <option value="2">Urgente</option>
                            <option value="3">Para hoy</option>
                        </select>
                    </div>
                </div>
                <div class="estimated-times">
                    <div class="time-input-group">
                        <i class="ph ph-drop"></i>
                        <input type="number" class="est-wash" value="50"> min
                    </div>
                    <div class="time-input-group">
                        <i class="ph ph-wind"></i>
                        <input type="number" class="est-dry" value="45"> min
                    </div>
                </div>
            </div>
        `;
        wrapper.insertAdjacentHTML('beforeend', html);
    }

    estimateTimes(element) {
        const card = element.closest('.subload-card');
        const fabric = card.querySelector('.fabric-type').value;
        const weight = parseInt(card.querySelector('.weight-input').value) || 0;
        
        const base = this.timeDb[fabric];
        
        // Slight modifier: +5 mins per 10 over 20lbs (just as logic example)
        const weightMod = weight > 20 ? Math.floor((weight - 20) / 10) * 5 : 0;

        card.querySelector('.est-wash').value = base.w + weightMod;
        card.querySelector('.est-dry').value = base.d + weightMod;
        
        this.calculateOrderETA();
    }

    processClientForm() {
        const clientName = document.getElementById('client-name').value.trim();
        if (!clientName) {
            alert('Ingrese el nombre de la orden o cliente');
            return;
        }

        const cards = document.querySelectorAll('.subload-card');
        if (cards.length === 0) return;

        // Generate unique Order ID
        const orderId = 'ORD-' + Math.random().toString(36).substr(2, 5).toUpperCase();

        // Register global order
        this.orders[orderId] = {
            id: orderId,
            client: clientName,
            totalSubloads: cards.length,
            finishedSubloads: 0
        };

        // Pre-calculate all subloads (buckets) to get real total count
        const allJobsData = [];
        cards.forEach((card, i) => {
            const fabric = card.querySelector('.fabric-type');
            const fabricText = fabric.options[fabric.selectedIndex].text;
            const weightInput = parseFloat(card.querySelector('.weight-input').value) || 0;
            const priority = parseInt(card.querySelector('.urgency-select').value);
            const wTimeBase = parseInt(card.querySelector('.est-wash').value);
            const dTimeBase = parseInt(card.querySelector('.est-dry').value);

            // Logic: If > 25, split in 20s. Else keep same.
            let weightRemaining = weightInput;
            let subBuckets = [];
            
            if (weightRemaining > 25) {
                while (weightRemaining > 0) {
                    if (weightRemaining > 20) {
                        subBuckets.push(20);
                        weightRemaining -= 20;
                    } else {
                        subBuckets.push(parseFloat(weightRemaining.toFixed(2)));
                        weightRemaining = 0;
                    }
                }
            } else {
                subBuckets.push(weightInput);
            }

            subBuckets.forEach(bWeight => {
                // Adjust times proportionally or keep base? 
                // User said: "cargas mayores deben de dividirse en cargas extra (aunque sean del mismo tipo)"
                // We'll keep the estimated times from the UI which correspond to a "normal" load.
                allJobsData.push({
                    fabric: fabricText,
                    weight: bWeight,
                    priority: priority,
                    washTime: wTimeBase,
                    dryTime: dTimeBase
                });
            });
        });

        // Register global order with REAL count of buckets
        this.orders[orderId] = {
            id: orderId,
            client: clientName,
            totalSubloads: allJobsData.length,
            finishedSubloads: 0
        };

        allJobsData.forEach((job, i) => {
            this.queue.push({
                id: this.jobCounter++,
                orderId: orderId,
                client: clientName,
                subloadIndex: i + 1,
                fabric: job.fabric,
                weight: job.weight,
                priority: job.priority,
                washTime: job.washTime,
                dryTime: job.dryTime,
                state: 'queue',
                minTime: Math.min(job.washTime, job.dryTime),
                isPaused: false
            });
        });

        // Reset form
        document.getElementById('client-name').value = '';
        document.getElementById('subloads-wrapper').innerHTML = '';
        this.addSubloadForm();
        
        this.updateQueueBoard();
        this.saveState();
    }

    // --- ALGORITHM LOGIC (Greedy Flexible Flow Shop based on Johnson) ---

    sortQueue() {
        // Groups by priority (3 High, 2 Med, 1 Low)
        const h = this.queue.filter(j => j.priority === 3);
        const m = this.queue.filter(j => j.priority === 2);
        const l = this.queue.filter(j => j.priority === 1);

        const applyJohnson = (arr) => {
            const u = arr.filter(j => j.washTime < j.dryTime).sort((a,b) => a.washTime - b.washTime);
            const v = arr.filter(j => j.washTime >= j.dryTime).sort((a,b) => b.dryTime - a.dryTime);
            return [...u, ...v];
        };

        this.queue = [...applyJohnson(h), ...applyJohnson(m), ...applyJohnson(l)];
    }

    // --- BOARDS RENDERING ---

    updateQueueBoard() {
        this.sortQueue();
        
        const listEl = document.getElementById('queue-list');
        document.getElementById('queue-count').textContent = this.queue.length;
        listEl.innerHTML = '';

        this.queue.forEach((job, index) => {
            const isWashFirst = job.washTime < job.dryTime;
            
            let urgencyLabel = 'No urgente';
            let badgeClass = '';
            if (job.priority === 2) { urgencyLabel = 'Urgente'; badgeClass = 'urgent'; }
            if (job.priority === 3) { urgencyLabel = 'Para hoy'; badgeClass = 'today'; }
            
            listEl.innerHTML += `
                <div class="job-card">
                    <div class="job-header">
                        <div>
                            <div class="job-client"><span class="queue-number">#${index + 1}</span> ${job.client} <span style="font-size:0.7rem; color:var(--text-muted);">[${job.orderId}]</span></div>
                            <div class="job-subload">Carga ${job.subloadIndex} • <i class="ph ph-t-shirt"></i> ${job.fabric} • ${job.weight}lbs</div>
                        </div>
                        <span class="job-badge ${badgeClass}" title="Razón de Orden">${urgencyLabel}</span>
                    </div>
                    <div class="job-details">
                        <span><i class="ph ph-drop"></i> ${job.washTime}m</span>
                        <span><i class="ph ph-wind"></i> ${job.dryTime}m</span>
                    </div>
                    <div class="job-actions">
                        <button class="action-btn btn-wash" onclick="app.openAssignModal(${job.id}, 'washer')">
                            <i class="ph ph-sign-out"></i> Lavar
                        </button>
                    </div>
                </div>
            `;
        });
    }

    renderMachines() {
        // Render Washers
        for(let i=1; i<=3; i++) {
            const w = this.washers[i];
            const el = document.getElementById(`washer-${i}`);
            if(w.job) {
                el.className = 'machine-slot active washer-active';
                el.innerHTML = this.generateMachineRunningHTML('LAV', i, w.job, w.timeRemaining, 'dryer');
            } else if(w.outOfService) {
                el.className = 'machine-slot out-of-service';
                el.innerHTML = `
                    <div class="machine-label" style="color:var(--accent-danger)">LAV ${i}</div>
                    <div class="machine-status" style="color:var(--accent-danger)"><i class="ph ph-warning"></i> Fuera de Servicio</div>
                    <button class="secondary-btn" style="margin-top:auto; padding:0.5rem; font-size:0.8rem" onclick="app.toggleMachineStatus('washer', ${i})">Habilitar</button>
                `;
            } else {
                el.className = 'machine-slot empty';
                el.innerHTML = `
                    <div class="machine-label">LAV ${i}</div>
                    <div class="machine-status">Libre</div>
                    <button class="secondary-btn" style="margin-top:auto; padding:0.5rem; border:none; color:var(--text-muted); opacity:0.3; transition:0.3s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.3" onclick="app.toggleMachineStatus('washer', ${i})"><i class="ph ph-warning-octagon"></i> Falla</button>
                `;
            }
        }

        // Render Dryers
        for(let i=1; i<=3; i++) {
            const d = this.dryers[i];
            const el = document.getElementById(`dryer-${i}`);
            if(d.job) {
                el.className = 'machine-slot active dryer-active';
                el.innerHTML = this.generateMachineRunningHTML('SEC', i, d.job, d.timeRemaining, 'done');
            } else if(d.outOfService) {
                el.className = 'machine-slot out-of-service';
                el.innerHTML = `
                    <div class="machine-label" style="color:var(--accent-danger)">SEC ${i}</div>
                    <div class="machine-status" style="color:var(--accent-danger)"><i class="ph ph-warning"></i> Fuera de Servicio</div>
                    <button class="secondary-btn" style="margin-top:auto; padding:0.5rem; font-size:0.8rem" onclick="app.toggleMachineStatus('dryer', ${i})">Habilitar</button>
                `;
            } else {
                el.className = 'machine-slot empty';
                el.innerHTML = `
                    <div class="machine-label">SEC ${i}</div>
                    <div class="machine-status">Libre</div>
                    <button class="secondary-btn" style="margin-top:auto; padding:0.5rem; border:none; color:var(--text-muted); opacity:0.3; transition:0.3s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.3" onclick="app.toggleMachineStatus('dryer', ${i})"><i class="ph ph-warning-octagon"></i> Falla</button>
                `;
            }
        }
        
        this.calculateOrderETA();
    }

    generateMachineRunningHTML(label, machineNum, job, minsLeft, nextTarget) {
        const isUrgent = minsLeft <= 5 ? 'urgent' : '';
        const timeStr = job.isPaused ? 'PAUSADO' : (minsLeft <= 0 ? '¡Listo!' : `${minsLeft}m`);
        const pauseClass = job.isPaused ? 'paused' : '';

        const mType = nextTarget === 'dryer' ? 'washer' : 'dryer';

        // Colored Active Controls
        let pauseBtnHtml = job.isPaused
            ? `<button class="action-btn" style="flex:0.5; background:var(--accent-success); color:var(--bg-dark); border:none" onclick="app.togglePause('${mType}', ${machineNum})" title="Reanudar"><i class="ph ph-play"></i></button>`
            : `<button class="action-btn" style="flex:0.5; background:rgba(255,255,255,0.15); color:#fff; border:1px solid rgba(255,255,255,0.3)" onclick="app.togglePause('${mType}', ${machineNum})" title="Pausar"><i class="ph ph-pause"></i></button>`;

        let editBtnHtml = `<button class="action-btn" style="flex:0.5; background:rgba(255,255,255,0.15); color:#fff; border:1px solid rgba(255,255,255,0.3)" onclick="app.openEditModal('${mType}', ${machineNum})" title="Editar"><i class="ph ph-pencil-simple"></i></button>`;

        let primaryBtn = '';
        if(nextTarget === 'dryer') {
            primaryBtn = `<button class="action-btn btn-dry" onclick="app.openAssignModal(${job.id}, 'dryer', ${machineNum}, 'washer')" style="flex:2">A Secadora <i class="ph ph-arrow-right"></i></button>`;
        } else {
            primaryBtn = `<button class="action-btn btn-done" onclick="app.finishJob(${machineNum})" style="flex:2"><i class="ph ph-check"></i> Terminar</button>`;
        }

        return `
            <div class="machine-label">${label} ${machineNum}</div>
            <div class="job-client" style="margin-top:1.5rem">${job.client} <span style="font-size:0.7rem; color:var(--text-muted); opacity:0.8;">[${job.orderId}]</span></div>
            <div class="job-subload">Carga ${job.subloadIndex} • <i class="ph ph-t-shirt"></i> ${job.fabric}</div>
            
            <div class="timer-display">
                <span class="timer-clock ${isUrgent} ${pauseClass}">${timeStr}</span>
                <span class="job-subload" style="font-size:0.7rem">TIEMPO RESTANTE</span>
            </div>

            <div class="job-actions" style="margin-top:1rem">
                ${primaryBtn}
                ${pauseBtnHtml}
                ${editBtnHtml}
            </div>
        `;
    }

    // --- MODAL AND ASSIGNMENT ---

    openAssignModal(jobId, targetType, sourceMachId = null, sourceMachType = null) {
        this.activeJobId = jobId;
        this.activeTargetType = targetType;
        this.sourceMachId = sourceMachId;
        this.sourceMachType = sourceMachType;

        const modal = document.getElementById('assign-modal');
        const optsContainer = document.getElementById('assign-options');
        const details = document.getElementById('assign-job-details');

        // Find job details
        let job = null;
        if(sourceMachType === 'washer') job = this.washers[sourceMachId].job;
        else job = this.queue.find(j => j.id === jobId);

        details.textContent = `Cliente: ${job.client} - Carga ${job.subloadIndex}`;

        optsContainer.innerHTML = '';
        const dict = targetType === 'washer' ? this.washers : this.dryers;
        const typeName = targetType === 'washer' ? 'Lavadora' : 'Secadora';

        for(let i=1; i<=3; i++) {
            const m = dict[i];
            const isUnavailable = m.job !== null || m.outOfService;
            const status = m.job ? `Ocupada (${m.timeRemaining}m rest)` : (m.outOfService ? 'Fuera de Servicio' : 'Libre');
            const classNames = isUnavailable ? 'machine-opt-btn occupied' : 'machine-opt-btn';
            
            optsContainer.innerHTML += `
                <button class="${classNames}" ${isUnavailable ? 'disabled' : ''} onclick="app.assignJobToMachine(${i})">
                    <span>${typeName} ${i}</span>
                    <span>${status}</span>
                </button>
            `;
        }

        modal.classList.add('active');
    }

    closeModal() {
        document.getElementById('assign-modal').classList.remove('active');
        this.activeJobId = null;
    }

    assignJobToMachine(machineId) {
        let job = null;
        
        // 1. Get Job & Remove from Source
        if(this.sourceMachType === 'washer') {
            job = this.washers[this.sourceMachId].job;
            this.washers[this.sourceMachId].job = null; // Free washer
            clearInterval(this.washers[this.sourceMachId].interval);
            
            // Log real wash end and dry start
            if(job.cycleTrack) {
                job.cycleTrack.endedWashAt = Date.now();
                job.cycleTrack.startedDryAt = Date.now();
            }

        } else {
            const qIdx = this.queue.findIndex(j => j.id === this.activeJobId);
            job = this.queue.splice(qIdx, 1)[0];
            
            // Initiate tracking
            if(!job.cycleTrack) job.cycleTrack = {};
            job.cycleTrack.startedWashAt = Date.now();
        }

        // 2. Assign to Target
        const targetDict = this.activeTargetType === 'washer' ? this.washers : this.dryers;
        if (targetDict[machineId].interval) clearInterval(targetDict[machineId].interval);
        targetDict[machineId].job = job;
        targetDict[machineId].job.isPaused = false;
        targetDict[machineId].timeRemaining = this.activeTargetType === 'washer' ? job.washTime : job.dryTime;

        // 3. Start Timer
        targetDict[machineId].interval = setInterval(() => {
            if(!targetDict[machineId].job.isPaused && targetDict[machineId].timeRemaining > 0) {
                targetDict[machineId].timeRemaining--;
                this.renderMachines(); // re-render to update clock
                this.saveState();
            }
        }, 60000); // 1 minute in real life

        this.closeModal();
        this.updateQueueBoard();
        this.renderMachines();
        this.saveState();
    }

    finishJob(dryerId) {
        clearInterval(this.dryers[dryerId].interval);
        const job = this.dryers[dryerId].job;
        
        // Notify the Order global object that one of its subloads has finished secadora
        if (job && job.orderId && this.orders[job.orderId]) {
            this.orders[job.orderId].finishedSubloads++;
        }

        // Finalize Tracking and Send to Analytics
        if(job && job.cycleTrack) {
            job.cycleTrack.endedDryAt = Date.now();
            this.logJobHistory(job);
        }

        this.dryers[dryerId].job = null;
        this.renderMachines();
        this.renderFoldingBoard();
        this.saveState();
    }

    async logJobHistory(job) {
        // Calculate diff in minutes
        const realWash = job.cycleTrack.startedWashAt && job.cycleTrack.endedWashAt 
            ? Math.round((job.cycleTrack.endedWashAt - job.cycleTrack.startedWashAt) / 60000) 
            : job.washTime; 
        const realDry = job.cycleTrack.startedDryAt && job.cycleTrack.endedDryAt
            ? Math.round((job.cycleTrack.endedDryAt - job.cycleTrack.startedDryAt) / 60000)
            : job.dryTime;
            
        const record = {
            order_id: job.orderId,
            subload: job.subloadIndex,
            fabric: job.fabric,
            weight: job.weight,
            est_wash: job.washTime,
            real_wash: realWash,
            est_dry: job.dryTime,
            real_dry: realDry,
            completed_at: new Date().toISOString()
        };
        
        try {
            await this.supabase.from('job_history').insert([record]);
        } catch(e) { console.error('Failed to log history', e); }
    }

    // --- CONTROLS IN HOT (EDIT / PAUSE / BROKEN) ---
    
    toggleMachineStatus(type, id) {
        if(type === 'washer') this.washers[id].outOfService = !this.washers[id].outOfService;
        else this.dryers[id].outOfService = !this.dryers[id].outOfService;
        this.renderMachines();
        this.saveState();
    }

    togglePause(machineType, machineId) {
        const dict = machineType === 'washer' ? this.washers : this.dryers;
        if(dict[machineId] && dict[machineId].job) {
            dict[machineId].job.isPaused = !dict[machineId].job.isPaused;
            this.renderMachines();
            this.saveState();
        }
    }

    openEditModal(machineType, machineId) {
        this.editMachType = machineType;
        this.editMachId = machineId;
        const dict = machineType === 'washer' ? this.washers : this.dryers;
        const state = dict[machineId];

        if(state && state.job) {
            document.getElementById('edit-client-name').value = state.job.client;
            document.getElementById('edit-time-remaining').value = state.timeRemaining;
            document.getElementById('edit-job-modal').style.display = 'flex';
        }
    }

    closeEditModal() {
        this.editMachType = null;
        this.editMachId = null;
        document.getElementById('edit-job-modal').style.display = 'none';
    }

    saveJobEdits() {
        if(!this.editMachType || !this.editMachId) return;
        
        const dict = this.editMachType === 'washer' ? this.washers : this.dryers;
        const state = dict[this.editMachId];

        if(state && state.job) {
            const newClient = document.getElementById('edit-client-name').value.trim();
            const newTime = parseInt(document.getElementById('edit-time-remaining').value);

            if(newClient) state.job.client = newClient;
            if(!isNaN(newTime) && newTime >= 0) state.timeRemaining = newTime;

            this.closeEditModal();
            this.renderMachines();
            this.saveState();
        }
    }

    // --- FOLDING AND DELIVERY BOARD ---

    renderFoldingBoard() {
        const listEl = document.getElementById('folding-list');
        listEl.innerHTML = '';
        
        let foldingCardsCount = 0;

        // Iterate over global track of orders
        Object.values(this.orders).forEach(order => {
            // Only show orders that have started flowing out of dryers (at least 1 finished)
            if (order.finishedSubloads > 0) {
                foldingCardsCount++;
                const isComplete = order.finishedSubloads === order.totalSubloads;
                
                // Build visual pip bar for progress
                let pipsHTML = '';
                for(let p=0; p<order.totalSubloads; p++) {
                    pipsHTML += `<div class="pip ${p < order.finishedSubloads ? 'done' : ''}"></div>`;
                }

                if (!isComplete) {
                    listEl.innerHTML += `
                        <div class="job-card" style="opacity: 0.8; border-color: rgba(255,165,2,0.3);">
                            <div class="job-header">
                                <div class="job-client">${order.client}</div>
                                <span class="job-badge" style="color:var(--text-muted); border:1px solid var(--text-muted)">EN ESPERA</span>
                            </div>
                            <div class="job-subload">Orden: ${order.id}</div>
                            <div class="order-status-bar">${pipsHTML}</div>
                            <div style="font-size:0.8rem; margin-top:0.5rem; color:var(--priority-medium);">
                                <i class="ph ph-spinner ph-spin"></i> Falta terminar ${order.totalSubloads - order.finishedSubloads} carga(s) para doblar.
                            </div>
                        </div>
                    `;
                } else {
                    listEl.innerHTML += `
                        <div class="job-card" style="border-color: var(--accent-success); background: rgba(46, 213, 115, 0.05);">
                            <div class="job-header">
                                <div class="job-client" style="color: var(--accent-success)">${order.client}</div>
                                <span class="job-badge" style="color:var(--accent-success); border:1px solid var(--accent-success); background:rgba(46, 213, 115, 0.1);">LISTO</span>
                            </div>
                            <div class="job-subload">Orden: ${order.id}</div>
                            <div class="order-status-bar">${pipsHTML}</div>
                            <div style="font-size:0.8rem; margin-top:0.5rem; color:var(--text-muted);">
                                Listo para doblar y empacar.
                            </div>
                            <div class="job-actions" style="margin-top:1rem;">
                                <button class="action-btn btn-done" onclick="app.deliverOrder('${order.id}')" style="width:100%">
                                    <i class="ph ph-check-square"></i> Marcar Entregado
                                </button>
                            </div>
                        </div>
                    `;
                }
            }
        });

        document.getElementById('folding-count').textContent = foldingCardsCount;
    }

    deliverOrder(orderId) {
        delete this.orders[orderId];
        this.renderFoldingBoard();
        this.saveState();
    }

    // --- ESTIMADOR ETA INTELIGENTE ---
    calculateOrderETA() {
        let queueWashMins = 0; let queueDryMins = 0;
        this.queue.forEach(j => { queueWashMins += j.washTime; queueDryMins += j.dryTime; });

        let runningWashMins = 0; let activeWashers = 0;
        for(let i=1; i<=3; i++) {
            if(!this.washers[i].outOfService) activeWashers++;
            if(this.washers[i].job && !this.washers[i].job.isPaused) runningWashMins += this.washers[i].timeRemaining;
        }

        let runningDryMins = 0; let activeDryers = 0;
        for(let i=1; i<=3; i++) {
            if(!this.dryers[i].outOfService) activeDryers++;
            if(this.dryers[i].job && !this.dryers[i].job.isPaused) runningDryMins += this.dryers[i].timeRemaining;
        }

        activeWashers = activeWashers || 1; // Prevent Div0
        activeDryers = activeDryers || 1;

        const totalTrafficMins = Math.round((queueWashMins + runningWashMins) / activeWashers + (queueDryMins + runningDryMins) / activeDryers);

        let orderWashTime = 0; let orderDryTime = 0;
        const cards = document.querySelectorAll('.subload-card');
        cards.forEach(card => {
            const wBase = parseInt(card.querySelector('.est-wash').value) || 0;
            const dBase = parseInt(card.querySelector('.est-dry').value) || 0;
            const weightInput = parseFloat(card.querySelector('.weight-input').value) || 0;
            
            // Calculate how many physical loads this weight generates
            let numBuckets = 1;
            if (weightInput > 25) {
                numBuckets = Math.ceil(weightInput / 20);
            }
            
            orderWashTime += (wBase * numBuckets);
            orderDryTime += (dBase * numBuckets);
        });
        
        const newOrderMins = Math.round(orderWashTime / activeWashers + orderDryTime / activeDryers);
        const totalMinsAdded = totalTrafficMins + newOrderMins;

        let completionDate = new Date();
        completionDate.setMinutes(completionDate.getMinutes() + totalMinsAdded);

        // Turno Laboral Overflow (7 AM a 16:00 PM - último inicio)
        let jumps = 0;
        // Si el cálculo cae fuera del horario, empujar al día siguiente a las 7 AM
        while (completionDate.getHours() >= 16 || completionDate.getHours() < 7) {
            jumps++; // Prevent infinite loops in extreme edge cases
            if(jumps > 30) break;
            
            // Si nos pasamos de las 16:00, tomamos los minutos sobrantes de "ese día de trabajo"
            if (completionDate.getHours() >= 16) {
                // Cuántos minutos exceden de las 16:00
                const diffInMins = ((completionDate.getHours() - 16) * 60) + completionDate.getMinutes();
                // Saltamos al sig. día
                completionDate.setDate(completionDate.getDate() + 1);
                // Ponemos a las 7 AM, y le sumamos los minutos que traíamos de deuda
                completionDate.setHours(7, diffInMins, 0, 0);
            }
            // Si por pura matemática cayó antes de las 7am (ej, un remanente se sumó a las 00:00), lo forzamos a las 7
            else if (completionDate.getHours() < 7) {
                const diffInMins = (completionDate.getHours() * 60) + completionDate.getMinutes();
                completionDate.setHours(7, diffInMins, 0, 0);
            }
        }
        
        const now = new Date();
        const diffInDays = Math.floor((completionDate.getTime() - new Date().setHours(0,0,0,0)) / (1000 * 60 * 60 * 24));
        
        let dayStr = "";
        if (diffInDays === 0) dayStr = "Hoy ";
        else if (diffInDays === 1) dayStr = "Mañana ";
        else {
            const formatter = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
            dayStr = formatter.format(completionDate) + " - ";
            // Capitalizar la primera letra del dia
            dayStr = dayStr.charAt(0).toUpperCase() + dayStr.slice(1);
        }

        const timeStr = completionDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        const badgeEl = document.getElementById('eta-badge');
        if(!badgeEl) return;
        
        if (diffInDays > 0) {
            badgeEl.className = 'eta-badge tomorrow';
            badgeEl.innerHTML = `<i class="ph ph-calendar-plus"></i> Extendido: SLA ${dayStr}${timeStr}`;
        } else {
            badgeEl.className = 'eta-badge today';
            badgeEl.innerHTML = `<i class="ph ph-clock"></i> Entrega Rápida: ${dayStr}${timeStr}`;
        }
    }

    // --- ANALYTICS DASHBOARD ---

    promptAdmin() {
        document.getElementById('admin-password').value = '';
        document.getElementById('admin-modal').classList.add('active');
        document.getElementById('admin-password').focus();
    }

    closeAdminModal() {
        document.getElementById('admin-modal').classList.remove('active');
    }

    verifyAdmin() {
        const pass = document.getElementById('admin-password').value;
        if(pass === '0000') {
            this.closeAdminModal();
            this.showAnalytics();
        } else {
            alert("Contraseña Incorrecta.");
        }
    }

    async showAnalytics() {
        document.getElementById('dashboard-view').style.display = 'none';
        document.getElementById('analytics-view').style.display = 'flex';
        
        const tbody = document.getElementById('analytics-tbody');
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;"><i class="ph ph-spinner ph-spin"></i> Cargando Historial...</td></tr>';

        try {
            const { data, error } = await this.supabase
                .from('job_history')
                .select('*')
                .order('completed_at', { ascending: false })
                .limit(50);
            
            if(error) throw error;
            
            tbody.innerHTML = '';
            if(data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted)">Aún no hay registros de cargas terminadas.</td></tr>';
                return;
            }

            data.forEach(row => {
                const dateObj = new Date(row.completed_at);
                const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                
                const washDiff = row.real_wash - row.est_wash;
                const dryDiff = row.real_dry - row.est_dry;
                const totalDiff = washDiff + dryDiff;
                
                let diffClass = 'diff-neutral';
                let diffText = 'Exacto';
                if(totalDiff > 0) { diffClass = 'diff-positive'; diffText = `+${totalDiff}m Tarde`; }
                else if(totalDiff < 0) { diffClass = 'diff-negative'; diffText = `${totalDiff}m Rápido`; }

                tbody.innerHTML += `
                    <tr>
                        <td style="color:var(--text-muted); font-size:0.8rem">${dateStr}</td>
                        <td style="font-weight:700; color:var(--primary)">${row.order_id}</td>
                        <td>#${row.subload}</td>
                        <td>${row.fabric}</td>
                        <td>${row.weight} lbs</td>
                        <td>${row.est_wash}m / <strong>${row.real_wash}m</strong></td>
                        <td>${row.est_dry}m / <strong>${row.real_dry}m</strong></td>
                        <td><span class="${diffClass}">${diffText}</span></td>
                        <td><button onclick="app.deleteHistoryRecord('${row.id}')" style="background:transparent; border:none; color:var(--accent-danger); cursor:pointer;" title="Borrar Registro"><i class="ph ph-trash"></i></button></td>
                    </tr>
                `;
            });
            
        } catch(err) {
            console.error(err);
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--accent-danger)">Error cargando Supabase. Revisa la consola o si creaste la tabla.</td></tr>';
        }
    }

    exitAdmin() {
        document.getElementById('analytics-view').style.display = 'none';
        document.getElementById('dashboard-view').style.display = 'flex';
    }

    async deleteHistoryRecord(id) {
        if(!confirm("¿Estás seguro de querer borrar este registro del historial?")) return;
        try {
            const { error } = await this.supabase.from('job_history').delete().eq('id', id);
            if(error) throw error;
            this.showAnalytics(); // Refresh
        } catch(err) { console.error(err); alert("Error borrando el registro."); }
    }

    async exportToExcel() {
        try {
            const { data, error } = await this.supabase.from('job_history').select('*').order('completed_at', { ascending: false });
            if(error) throw error;
            if(!data || data.length === 0) return alert("No hay datos para exportar");

            let csvContent = "data:text/csv;charset=utf-8,";
            // Headers
            csvContent += "Fecha,Orden,Carga_Num,Tela,Peso_lbs,Lavado_Estimado,Lavado_Real,Secado_Estimado,Secado_Real,Desviacion_Total_Minutos\n";
            
            data.forEach(row => {
               const dateObj = new Date(row.completed_at);
               const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
               const diff = (row.real_wash - row.est_wash) + (row.real_dry - row.est_dry);
               
               csvContent += `"${dateStr}","${row.order_id}",${row.subload},"${row.fabric}",${row.weight},${row.est_wash},${row.real_wash},${row.est_dry},${row.real_dry},${diff}\n`;
            });

            // Trigger DL Download
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `WashFlow_Analytics_${new Date().toLocaleDateString().replace(/\//g,'-')}.csv`); // CSV es retrocompatible perfecto con excel
            document.body.appendChild(link); // Required for FF
            link.click();
            document.body.removeChild(link);

        } catch(err) { console.error(err); alert("Falló la exportación.")}
    }
}

const app = new WashFlowApp();
