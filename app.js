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
        this.customers = []; // Cache of customer names for autocomplete

        // Machine State (1 = Washer 1, 2 = Washer 2... etc)
        this.washers = {
            1: { type: 'washer', id: 1, job: null, timeRemaining: 0, interval: null, outOfService: false },
            2: { type: 'washer', id: 2, job: null, timeRemaining: 0, interval: null, outOfService: false },
            3: { type: 'washer', id: 3, job: null, timeRemaining: 0, interval: null, outOfService: false }
        };
        this.dryers = {
            1: { type: 'dryer', id: 1, job: null, timeRemaining: 0, interval: null, outOfService: false },
            2: { type: 'dryer', id: 2, job: null, timeRemaining: 0, interval: null, outOfService: false },
            3: { type: 'dryer', id: 3, job: null, timeRemaining: 0, interval: null, outOfService: false }
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

        // Drag & Drop State
        this.dragData = null;

        // State persistence markers
        this.lastProcessedTime = 0;

        this.initDOM();
        this.startGlobalClock();
        
        // Start from memory while Cloud loads, then fetch Cloud
        this.loadStateLocal();
        this.initCloudSync();
        this.initCustomers(); // Fetch customers
    }

    // --- CLOUD & STATE PERSISTENCE ---

    async initCloudSync() {
        console.log('⚡ Iniciando sincronización de nube...');
        await this.loadFromCloud();

        // Subscribe to real-time changes from other devices
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
        const state = this.createStateObject();
        localStorage.setItem('washflow_state', JSON.stringify(state));

        // Save to Supabase Cloud
        try {
            const { error } = await this.supabase.from('app_state').upsert({ id: 1, state: state });
            if (error) {
                console.error('❌ Error de Supabase al escribir data:', error);
            }
        } catch(e) { 
            console.error('❌ Cloud save falló con Excepción:', e); 
        }
    }

    createStateObject() {
        const safeWashers = JSON.parse(JSON.stringify(this.washers));
        const safeDryers = JSON.parse(JSON.stringify(this.dryers));
        
        for(let i=1; i<=3; i++) {
            delete safeWashers[i].interval;
            delete safeDryers[i].interval;
        }

        const state = {
            queue: this.queue,
            orders: this.orders,
            jobCounter: this.jobCounter,
            subloadCounter: this.subloadCounter,
            washers: safeWashers,
            dryers: safeDryers,
            saveTime: Date.now()
        };
        
        this.lastProcessedTime = state.saveTime;
        return state;
    }

    loadStateLocal() {
        const saved = localStorage.getItem('washflow_state');
        if(saved) {
            this.applyState(JSON.parse(saved));
        } else {
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
        if (!state) return;
        
        if (state.saveTime && state.saveTime < this.lastProcessedTime) {
            console.log('⏳ Ignorando estado antiguo (Nube < Local):', state.saveTime, '<', this.lastProcessedTime);
            return;
        }
        this.lastProcessedTime = state.saveTime || Date.now();

        try {
            for(let i=1; i<=3; i++) {
                if(this.washers[i] && this.washers[i].interval) clearInterval(this.washers[i].interval);
                if(this.dryers[i] && this.dryers[i].interval) clearInterval(this.dryers[i].interval);
            }

            this.queue = state.queue || [];
            this.orders = state.orders || {};
            this.jobCounter = state.jobCounter || 1;
            this.subloadCounter = state.subloadCounter || 1;

            // Restore Washers
            if(state.washers) {
                for(let i=1; i<=3; i++) {
                    const w = state.washers[i];
                    this.washers[i] = w;
                    if(w.job) {
                        w.timeRemaining = w.job.isPaused ? w.timeRemaining : Math.max(0, w.timeRemaining - Math.floor((Date.now() - state.saveTime) / 60000));
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

            this.updateQueueBoard();
            this.renderMachines();
            this.renderFoldingBoard();
            
        } catch (e) {
            console.error("Failed to load state", e);
        }
    }

    initDOM() {
        document.getElementById('add-subload-btn')?.addEventListener('click', () => this.addSubloadForm());
        document.getElementById('submit-client-btn')?.addEventListener('click', () => this.processClientForm());

        // Setup drop listener on folding container
        const foldingList = document.getElementById('folding-list');
        if (foldingList) {
            foldingList.addEventListener('dragover', (e) => this.handleDragOver(e, 'folding'));
            foldingList.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            foldingList.addEventListener('drop', (e) => this.handleDrop(e, 'folding'));
        }

        // Close modals on Escape key
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeRegisterModal();
                this.closeModal();
                this.closeEditModal();
                this.closeAdminModal();
            }
        });

        // Close modal on click backdrop
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('active');
                }
            });
        });
    }

    startGlobalClock() {
        const clockEl = document.getElementById('global-clock');
        setInterval(() => {
            const now = new Date();
            clockEl.textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        }, 1000);
    }

    // --- REGISTER MODAL ---

    openRegisterModal() {
        const modal = document.getElementById('register-order-modal');
        if (modal) {
            modal.classList.add('active');
            document.getElementById('client-name')?.focus();
            this.calculateOrderETA();
        }
    }

    closeRegisterModal() {
        const modal = document.getElementById('register-order-modal');
        if (modal) {
            modal.classList.remove('active');
        }
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
                        <span class="help-text">Máx 25lb por máquina (Autodivisión a 20lb)</span>
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
                        <input type="number" class="est-wash" value="50"> min lavado
                    </div>
                    <div class="time-input-group">
                        <i class="ph ph-wind"></i>
                        <input type="number" class="est-dry" value="45"> min secado
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
        const weightMod = weight > 20 ? Math.floor((weight - 20) / 10) * 5 : 0;

        card.querySelector('.est-wash').value = base.w + weightMod;
        card.querySelector('.est-dry').value = base.d + weightMod;
        
        this.calculateOrderETA();
    }

    // --- CUSTOMER AUTOCOMPLETE ---

    async initCustomers() {
        try {
            const { data, error } = await this.supabase
                .from('customers')
                .select('full_name')
                .order('full_name', { ascending: true });
            
            if (error) {
                console.warn('⚠️ No se pudieron cargar los clientes de Supabase.');
                return;
            }

            this.customers = data ? data.map(c => c.full_name) : [];
            this.updateCustomerDatalist();
        } catch (e) {
            console.error('Error fetching customers:', e);
        }
    }

    updateCustomerDatalist() {
        const datalist = document.getElementById('customer-list');
        if (!datalist) return;
        
        datalist.innerHTML = this.customers
            .map(name => `<option value="${name}">`)
            .join('');
    }

    async checkAndAddCustomer(name) {
        if (!name) return;
        const exists = this.customers.some(c => c.toLowerCase() === name.trim().toLowerCase());
        
        if (!exists) {
            try {
                const { error } = await this.supabase
                    .from('customers')
                    .insert([{ full_name: name.trim() }]);
                
                if (!error) {
                    this.customers.push(name.trim());
                    this.customers.sort();
                    this.updateCustomerDatalist();
                }
            } catch (e) {
                console.error('Error saving new customer:', e);
            }
        }
    }

    async importCustomers(customerList) {
        const formatted = customerList.map(name => ({ full_name: name.trim() }));
        try {
            const { error } = await this.supabase.from('customers').insert(formatted);
            if (!error) {
                alert(`Se han importado ${customerList.length} clientes.`);
                this.initCustomers();
            } else {
                alert('Error al importar. Ver consola.');
            }
        } catch (e) {
            console.error('Excepción en importación:', e);
        }
    }

    processClientForm() {
        const clientName = document.getElementById('client-name').value.trim();
        if (!clientName) {
            alert('Ingrese el nombre de la orden o cliente');
            return;
        }

        this.checkAndAddCustomer(clientName);

        const cards = document.querySelectorAll('.subload-card');
        if (cards.length === 0) return;

        // Generate unique Order ID
        const orderId = 'ORD-' + Math.random().toString(36).substr(2, 5).toUpperCase();

        // Pre-calculate all subloads (buckets) with autodivision logic (> 25 lbs in 20 lb chunks)
        const allJobsData = [];
        cards.forEach((card) => {
            const fabric = card.querySelector('.fabric-type');
            const fabricText = fabric.options[fabric.selectedIndex].text;
            const weightInput = parseFloat(card.querySelector('.weight-input').value) || 0;
            const priority = parseInt(card.querySelector('.urgency-select').value);
            const wTimeBase = parseInt(card.querySelector('.est-wash').value) || 50;
            const dTimeBase = parseInt(card.querySelector('.est-dry').value) || 45;

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
                allJobsData.push({
                    fabric: fabricText,
                    weight: bWeight,
                    priority: priority,
                    washTime: wTimeBase,
                    dryTime: dTimeBase
                });
            });
        });

        // Register global order with count of subloads
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
        
        // Close modal
        this.closeRegisterModal();

        this.updateQueueBoard();
        this.saveState();
    }

    // --- ALGORITHM LOGIC ---

    sortQueue() {
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

    // --- DRAG AND DROP HANDLERS ---

    handleDragStart(e, source, id, machineId = null) {
        this.dragData = { source, id, machineId };
        e.dataTransfer.setData('text/plain', JSON.stringify(this.dragData));
        e.dataTransfer.effectAllowed = 'move';
        
        if (e.currentTarget && e.currentTarget.classList) {
            e.currentTarget.classList.add('is-dragging');
        }

        // Highlight valid drop targets
        if (source === 'queue') {
            for (let i = 1; i <= 3; i++) {
                if (!this.washers[i].job && !this.washers[i].outOfService) {
                    document.getElementById(`washer-${i}`)?.classList.add('valid-drop-target');
                }
                if (!this.dryers[i].job && !this.dryers[i].outOfService) {
                    document.getElementById(`dryer-${i}`)?.classList.add('valid-drop-target');
                }
            }
        } else if (source === 'washer') {
            // To other washers (same machine excluded)
            for (let i = 1; i <= 3; i++) {
                if (i !== machineId && !this.washers[i].job && !this.washers[i].outOfService) {
                    document.getElementById(`washer-${i}`)?.classList.add('valid-drop-target');
                }
            }
            // To dryers
            for (let i = 1; i <= 3; i++) {
                if (!this.dryers[i].job && !this.dryers[i].outOfService) {
                    document.getElementById(`dryer-${i}`)?.classList.add('valid-drop-target');
                }
            }
            // Back to queue
            document.getElementById('queue-list')?.classList.add('valid-drop-target');
            // To folding
            document.getElementById('folding-list')?.classList.add('valid-drop-target');
        } else if (source === 'dryer') {
            // To other dryers (same machine excluded)
            for (let i = 1; i <= 3; i++) {
                if (i !== machineId && !this.dryers[i].job && !this.dryers[i].outOfService) {
                    document.getElementById(`dryer-${i}`)?.classList.add('valid-drop-target');
                }
            }
            // To washers
            for (let i = 1; i <= 3; i++) {
                if (!this.washers[i].job && !this.washers[i].outOfService) {
                    document.getElementById(`washer-${i}`)?.classList.add('valid-drop-target');
                }
            }
            // Back to queue
            document.getElementById('queue-list')?.classList.add('valid-drop-target');
            // To folding
            document.getElementById('folding-list')?.classList.add('valid-drop-target');
        }
    }

    handleDragEnd(e) {
        this.dragData = null;
        document.querySelectorAll('.is-dragging').forEach(el => el.classList.remove('is-dragging'));
        document.querySelectorAll('.valid-drop-target').forEach(el => el.classList.remove('valid-drop-target'));
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    }

    handleDragOver(e, targetType, machineId = null) {
        if (!this.dragData) return;
        const { source, machineId: sourceMachId } = this.dragData;

        let isValid = false;
        if (targetType === 'washer' && machineId) {
            const destFree = !this.washers[machineId].job && !this.washers[machineId].outOfService;
            if (source === 'queue') {
                isValid = destFree;
            } else if (source === 'washer') {
                isValid = machineId !== sourceMachId && destFree;
            } else if (source === 'dryer') {
                isValid = destFree;
            }
        } else if (targetType === 'dryer' && machineId) {
            const destFree = !this.dryers[machineId].job && !this.dryers[machineId].outOfService;
            if (source === 'queue' || source === 'washer') {
                isValid = destFree;
            } else if (source === 'dryer') {
                isValid = machineId !== sourceMachId && destFree;
            }
        } else if (targetType === 'folding') {
            isValid = source === 'dryer' || source === 'washer';
        } else if (targetType === 'queue') {
            isValid = source === 'washer' || source === 'dryer';
        }

        if (isValid) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('drag-over');
        } else {
            e.dataTransfer.dropEffect = 'none';
        }
    }

    handleDragLeave(e) {
        e.currentTarget.classList.remove('drag-over');
    }

    handleDrop(e, targetType, machineId = null) {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        document.querySelectorAll('.valid-drop-target').forEach(el => el.classList.remove('valid-drop-target'));
        document.querySelectorAll('.is-dragging').forEach(el => el.classList.remove('is-dragging'));

        if (!this.dragData) return;
        const { source, id, machineId: sourceMachId } = this.dragData;

        // Queue -> Washer
        if (source === 'queue' && targetType === 'washer' && machineId) {
            if (!this.washers[machineId].job && !this.washers[machineId].outOfService) {
                this.assignJobDirectly(id, 'washer', machineId);
            }
        } 
        // Queue -> Dryer (Directly without washer!)
        else if (source === 'queue' && targetType === 'dryer' && machineId) {
            if (!this.dryers[machineId].job && !this.dryers[machineId].outOfService) {
                this.assignJobDirectly(id, 'dryer', machineId);
            }
        } 
        // Washer -> Dryer
        else if (source === 'washer' && targetType === 'dryer' && machineId) {
            if (!this.dryers[machineId].job && !this.dryers[machineId].outOfService) {
                this.transferWasherToDryer(sourceMachId, machineId);
            }
        } 
        // Washer -> Folding (skip dryer if only washed)
        else if (source === 'washer' && targetType === 'folding') {
            this.finishWasherDirectly(sourceMachId);
        }
        // Dryer -> Folding (finish drying)
        else if (source === 'dryer' && targetType === 'folding') {
            this.finishJob(sourceMachId);
        }
        // Washer -> Queue (regresar a cola)
        else if (source === 'washer' && targetType === 'queue') {
            this.returnJobToQueue('washer', sourceMachId);
        }
        // Dryer -> Queue (regresar a cola)
        else if (source === 'dryer' && targetType === 'queue') {
            this.returnJobToQueue('dryer', sourceMachId);
        }

        this.dragData = null;
    }

    // Direct Assignment (Drag & Drop helper)
    assignJobDirectly(jobId, targetType, machineId) {
        const qIdx = this.queue.findIndex(j => j.id === jobId);
        if (qIdx === -1) return;
        const job = this.queue.splice(qIdx, 1)[0];

        if (!job.cycleTrack) job.cycleTrack = {};
        if (targetType === 'washer') {
            job.cycleTrack.startedWashAt = Date.now();
        } else {
            job.cycleTrack.startedDryAt = Date.now();
        }

        const targetDict = targetType === 'washer' ? this.washers : this.dryers;
        if (targetDict[machineId].interval) clearInterval(targetDict[machineId].interval);
        
        targetDict[machineId].job = job;
        targetDict[machineId].job.isPaused = false;
        targetDict[machineId].timeRemaining = targetType === 'washer' ? job.washTime : job.dryTime;

        targetDict[machineId].interval = setInterval(() => {
            if (!targetDict[machineId].job.isPaused && targetDict[machineId].timeRemaining > 0) {
                targetDict[machineId].timeRemaining--;
                this.renderMachines();
                this.saveState();
            }
        }, 60000);

        this.updateQueueBoard();
        this.renderMachines();
        this.saveState();
    }

    // Transfer from washer to dryer
    transferWasherToDryer(washerId, dryerId) {
        const washer = this.washers[washerId];
        const dryer = this.dryers[dryerId];
        if (!washer || !washer.job || !dryer || dryer.job || dryer.outOfService) return;

        const job = washer.job;
        washer.job = null;
        clearInterval(washer.interval);

        if (job.cycleTrack) {
            job.cycleTrack.endedWashAt = Date.now();
            job.cycleTrack.startedDryAt = Date.now();
        }

        if (dryer.interval) clearInterval(dryer.interval);
        dryer.job = job;
        dryer.job.isPaused = false;
        dryer.timeRemaining = job.dryTime;

        dryer.interval = setInterval(() => {
            if (!dryer.job.isPaused && dryer.timeRemaining > 0) {
                dryer.timeRemaining--;
                this.renderMachines();
                this.saveState();
            }
        }, 60000);

        this.renderMachines();
        this.saveState();
    }

    // Move a job between machines of the same or different type (only if destination is free)
    moveJobBetweenMachines(sourceType, sourceId, targetType, targetId) {
        const sourceDict = sourceType === 'washer' ? this.washers : this.dryers;
        const targetDict = targetType === 'washer' ? this.washers : this.dryers;

        const sourceMach = sourceDict[sourceId];
        const targetMach = targetDict[targetId];

        if (!sourceMach || !sourceMach.job || !targetMach || targetMach.job || targetMach.outOfService) return;

        const job = sourceMach.job;
        clearInterval(sourceMach.interval);
        sourceMach.job = null;
        sourceMach.interval = null;

        targetMach.job = job;
        targetMach.job.isPaused = false;
        targetMach.timeRemaining = sourceMach.timeRemaining > 0
            ? sourceMach.timeRemaining
            : (targetType === 'washer' ? job.washTime : job.dryTime);

        targetMach.interval = setInterval(() => {
            if (!targetMach.job.isPaused && targetMach.timeRemaining > 0) {
                targetMach.timeRemaining--;
                this.renderMachines();
                this.saveState();
            }
        }, 60000);

        this.renderMachines();
        this.saveState();
    }

    // Return a job from a machine back to the queue (without losing it)
    returnJobToQueue(type, id) {
        const dict = type === 'washer' ? this.washers : this.dryers;
        const mach = dict[id];

        if (!mach || !mach.job) return;

        clearInterval(mach.interval);
        const job = mach.job;
        mach.job = null;
        mach.interval = null;

        job.state = 'queue';
        job.isPaused = false;
        this.queue.push(job);

        this.updateQueueBoard();
        this.renderMachines();
        this.saveState();
    }

    // Play finish sound when a wash or dry cycle completes
    playFinishSound() {
        try {
            const audio = new Audio('orchestra-hit-or-combo-sound-full-combo.mp3');
            audio.volume = 0.8;
            audio.play().catch(e => console.warn('⚠️ No se pudo reproducir el sonido de finalización:', e));
        } catch (e) {
            console.warn('⚠️ Error creando Audio:', e);
        }
    }

    // Direct wash completion to folding
    finishWasherDirectly(washerId) {
        this.playFinishSound();
        const washer = this.washers[washerId];
        if (!washer || !washer.job) return;

        clearInterval(washer.interval);
        const job = washer.job;
        
        if (job.orderId && this.orders[job.orderId]) {
            this.orders[job.orderId].finishedSubloads++;
        }

        if (job.cycleTrack) {
            job.cycleTrack.endedWashAt = Date.now();
            this.logJobHistory(job);
        }

        washer.job = null;
        this.renderMachines();
        this.renderFoldingBoard();
        this.saveState();
    }

    // --- BOARDS RENDERING ---

    updateQueueBoard() {
        this.sortQueue();
        
        const listEl = document.getElementById('queue-list');
        document.getElementById('queue-count').textContent = this.queue.length;
        listEl.innerHTML = '';

        this.queue.forEach((job, index) => {
            let urgencyLabel = 'No urgente';
            let badgeClass = '';
            if (job.priority === 2) { urgencyLabel = 'Urgente'; badgeClass = 'urgent'; }
            if (job.priority === 3) { urgencyLabel = 'Para hoy'; badgeClass = 'today'; }
            
            listEl.innerHTML += `
                <div class="job-card" draggable="true" ondragstart="app.handleDragStart(event, 'queue', ${job.id})" ondragend="app.handleDragEnd(event)">
                    <div class="job-card-header">
                        <div class="job-card-title-group">
                            <span class="queue-num">#${index + 1}</span>
                            <span class="job-client-name" title="${job.client}">${job.client}</span>
                            <span class="job-order-badge">[${job.orderId}]</span>
                        </div>
                        <span class="job-badge ${badgeClass}">${urgencyLabel}</span>
                    </div>
                    <div class="job-card-info">
                        <span class="info-pill"><i class="ph ph-stack"></i> Carga ${job.subloadIndex}</span>
                        <span class="info-pill"><i class="ph ph-t-shirt"></i> ${job.fabric}</span>
                        <span class="info-pill"><i class="ph ph-scales"></i> ${job.weight} lb</span>
                    </div>
                    <div class="job-card-times">
                        <span class="time-item"><i class="ph ph-drop"></i> ${job.washTime}m lavado</span>
                        <span class="time-item"><i class="ph ph-wind"></i> ${job.dryTime}m secado</span>
                    </div>
                    <div class="job-card-actions">
                        <button class="action-btn btn-wash" onclick="app.openAssignModal(${job.id}, 'washer')" title="Asignar a Lavadora">
                            <i class="ph ph-drop"></i> Lavar
                        </button>
                        <button class="action-btn btn-dry" onclick="app.openAssignModal(${job.id}, 'dryer')" title="Asignar directamente a Secadora">
                            <i class="ph ph-wind"></i> Secar
                        </button>
                        <span class="drag-hint" title="Arrastra a cualquier lavadora o secadora libre"><i class="ph ph-dots-six-vertical"></i></span>
                    </div>
                </div>
            `;
        });
    }

    renderMachines() {
        // Render Washers (Strictly 3 slots fitting on screen)
        for(let i=1; i<=3; i++) {
            const w = this.washers[i];
            const el = document.getElementById(`washer-${i}`);
            if (!el) continue;

            if(w.job) {
                const isFinished = w.timeRemaining <= 0;
                const isAttention = (w.timeRemaining <= 5 && !isFinished) || w.job.isPaused;
                let stateClass = isFinished ? 'state-finished' : (isAttention ? 'state-attention' : '');

                el.className = `machine-slot active washer-active ${stateClass}`;
                el.setAttribute('draggable', 'true');
                el.setAttribute('ondragstart', `app.handleDragStart(event, 'washer', ${w.job.id}, ${i})`);
                el.setAttribute('ondragend', `app.handleDragEnd(event)`);
                el.removeAttribute('ondragover');
                el.removeAttribute('ondrop');
                el.innerHTML = this.generateMachineRunningHTML('LAV', i, w.job, w.timeRemaining, 'dryer');
            } else if(w.outOfService) {
                el.className = 'machine-slot out-of-service';
                el.removeAttribute('draggable');
                el.removeAttribute('ondragstart');
                el.removeAttribute('ondragover');
                el.removeAttribute('ondrop');
                el.innerHTML = `
                    <div class="machine-slot-top">
                        <span class="machine-tag" style="color:var(--state-red)">LAV ${i}</span>
                        <span class="machine-badge badge-danger">FUERA DE SERVICIO</span>
                    </div>
                    <div class="machine-empty-body">
                        <i class="ph ph-warning" style="font-size:1.15rem; color:var(--state-red);"></i>
                        <span class="empty-text" style="color:var(--state-red); font-weight:700;">En Mantenimiento</span>
                    </div>
                    <div class="machine-empty-footer" style="justify-content:center;">
                        <button class="enable-btn" onclick="app.toggleMachineStatus('washer', ${i})">
                            <i class="ph ph-check"></i> Habilitar
                        </button>
                    </div>
                `;
            } else {
                el.className = 'machine-slot empty';
                el.removeAttribute('draggable');
                el.removeAttribute('ondragstart');
                el.setAttribute('ondragover', `app.handleDragOver(event, 'washer', ${i})`);
                el.setAttribute('ondragleave', `app.handleDragLeave(event)`);
                el.setAttribute('ondrop', `app.handleDrop(event, 'washer', ${i})`);
                el.innerHTML = `
                    <div class="machine-slot-top">
                        <span class="machine-tag">LAV ${i}</span>
                        <span class="machine-badge badge-free">LIBRE</span>
                    </div>
                    <div class="machine-empty-body">
                        <i class="ph ph-tray-arrow-down empty-icon"></i>
                        <span class="empty-text">Arrastra una carga aquí</span>
                    </div>
                    <div class="machine-empty-footer">
                        <button class="falla-btn" onclick="app.toggleMachineStatus('washer', ${i})">
                            <i class="ph ph-warning-octagon"></i> Falla
                        </button>
                    </div>
                `;
            }
        }

        // Render Dryers (Strictly 3 slots fitting on screen)
        for(let i=1; i<=3; i++) {
            const d = this.dryers[i];
            const el = document.getElementById(`dryer-${i}`);
            if (!el) continue;

            if(d.job) {
                const isFinished = d.timeRemaining <= 0;
                const isAttention = (d.timeRemaining <= 5 && !isFinished) || d.job.isPaused;
                let stateClass = isFinished ? 'state-finished' : (isAttention ? 'state-attention' : '');

                el.className = `machine-slot active dryer-active ${stateClass}`;
                el.setAttribute('draggable', 'true');
                el.setAttribute('ondragstart', `app.handleDragStart(event, 'dryer', ${d.job.id}, ${i})`);
                el.setAttribute('ondragend', `app.handleDragEnd(event)`);
                el.removeAttribute('ondragover');
                el.removeAttribute('ondrop');
                el.innerHTML = this.generateMachineRunningHTML('SEC', i, d.job, d.timeRemaining, 'done');
            } else if(d.outOfService) {
                el.className = 'machine-slot out-of-service';
                el.removeAttribute('draggable');
                el.removeAttribute('ondragstart');
                el.removeAttribute('ondragover');
                el.removeAttribute('ondrop');
                el.innerHTML = `
                    <div class="machine-slot-top">
                        <span class="machine-tag" style="color:var(--state-red)">SEC ${i}</span>
                        <span class="machine-badge badge-danger">FUERA DE SERVICIO</span>
                    </div>
                    <div class="machine-empty-body">
                        <i class="ph ph-warning" style="font-size:1.15rem; color:var(--state-red);"></i>
                        <span class="empty-text" style="color:var(--state-red); font-weight:700;">En Mantenimiento</span>
                    </div>
                    <div class="machine-empty-footer" style="justify-content:center;">
                        <button class="enable-btn" onclick="app.toggleMachineStatus('dryer', ${i})">
                            <i class="ph ph-check"></i> Habilitar
                        </button>
                    </div>
                `;
            } else {
                el.className = 'machine-slot empty';
                el.removeAttribute('draggable');
                el.removeAttribute('ondragstart');
                el.setAttribute('ondragover', `app.handleDragOver(event, 'dryer', ${i})`);
                el.setAttribute('ondragleave', `app.handleDragLeave(event)`);
                el.setAttribute('ondrop', `app.handleDrop(event, 'dryer', ${i})`);
                el.innerHTML = `
                    <div class="machine-slot-top">
                        <span class="machine-tag">SEC ${i}</span>
                        <span class="machine-badge badge-free">LIBRE</span>
                    </div>
                    <div class="machine-empty-body">
                        <i class="ph ph-tray-arrow-down empty-icon"></i>
                        <span class="empty-text">Arrastra una carga aquí</span>
                    </div>
                    <div class="machine-empty-footer">
                        <button class="falla-btn" onclick="app.toggleMachineStatus('dryer', ${i})">
                            <i class="ph ph-warning-octagon"></i> Falla
                        </button>
                    </div>
                `;
            }
        }
        
        this.calculateOrderETA();
    }

    generateMachineRunningHTML(label, machineNum, job, minsLeft, nextTarget) {
        const isFinished = minsLeft <= 0;
        const isUrgent = minsLeft <= 5 && !isFinished;
        const mType = nextTarget === 'dryer' ? 'washer' : 'dryer';

        let statusBadgeText = '';
        let statusBadgeClass = '';
        let timerStatusClass = '';

        if (job.isPaused) {
            statusBadgeText = 'PAUSADO';
            statusBadgeClass = 'badge-paused';
            timerStatusClass = 'timer-attention';
        } else if (isFinished) {
            statusBadgeText = '¡LISTO!';
            statusBadgeClass = 'badge-finished';
            timerStatusClass = 'timer-finished';
        } else if (isUrgent) {
            statusBadgeText = mType === 'washer' ? 'LAVANDO' : 'SECANDO';
            statusBadgeClass = 'badge-attention';
            timerStatusClass = 'timer-attention';
        } else {
            statusBadgeText = mType === 'washer' ? 'LAVANDO' : 'SECANDO';
            statusBadgeClass = 'badge-running';
            timerStatusClass = '';
        }

        const timeStr = job.isPaused ? 'PAUSA' : (isFinished ? '¡LISTO!' : `${minsLeft}m`);

        let primaryBtn = '';
        if(nextTarget === 'dryer') {
            const btnClass = isFinished ? 'btn-finished-action' : (isUrgent ? 'btn-attention-action' : 'btn-primary-action');
            primaryBtn = `<button class="action-btn ${btnClass}" onclick="app.openAssignModal(${job.id}, 'dryer', ${machineNum}, 'washer')" title="A Secadora"><i class="ph ph-wind"></i> A Secadora</button>`;
        } else {
            const btnClass = isFinished ? 'btn-finished-action' : 'btn-primary-action';
            primaryBtn = `<button class="action-btn ${btnClass}" onclick="app.finishJob(${machineNum})" title="Terminar"><i class="ph ph-check-circle"></i> Terminar</button>`;
        }

        let pauseBtn = job.isPaused
            ? `<button class="action-btn btn-icon-action" style="color:var(--state-yellow);" onclick="app.togglePause('${mType}', ${machineNum})" title="Reanudar"><i class="ph ph-play"></i></button>`
            : `<button class="action-btn btn-icon-action" onclick="app.togglePause('${mType}', ${machineNum})" title="Pausar"><i class="ph ph-pause"></i></button>`;

        let editBtn = `<button class="action-btn btn-icon-action" onclick="app.openEditModal('${mType}', ${machineNum})" title="Editar"><i class="ph ph-pencil-simple"></i></button>`;

        let priorityBadge = '';
        if (job.priority === 3) priorityBadge = `<span class="mach-detail-pill pill-today">Para hoy</span>`;
        else if (job.priority === 2) priorityBadge = `<span class="mach-detail-pill pill-urgent">Urgente</span>`;

        return `
            <div class="machine-slot-top">
                <div class="mach-identity">
                    <span class="machine-tag">${label} ${machineNum}</span>
                    <span class="mach-client-name" title="${job.client}">${job.client}</span>
                    <span class="mach-order-id">[${job.orderId}]</span>
                </div>
                <div class="mach-status-group">
                    <span class="mach-timer-pill ${timerStatusClass}">${timeStr}</span>
                    <span class="machine-badge ${statusBadgeClass}">${statusBadgeText}</span>
                </div>
            </div>

            <div class="machine-slot-mid">
                <span class="mach-detail-pill"><i class="ph ph-stack"></i> Carga ${job.subloadIndex}</span>
                <span class="mach-detail-pill"><i class="ph ph-t-shirt"></i> ${job.fabric}</span>
                <span class="mach-detail-pill"><i class="ph ph-scales"></i> ${job.weight} lb</span>
                ${priorityBadge}
            </div>

            <div class="machine-actions-row">
                ${primaryBtn}
                ${pauseBtn}
                ${editBtn}
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
        const title = document.getElementById('assign-modal-title');

        let job = null;
        if(sourceMachType === 'washer') job = this.washers[sourceMachId].job;
        else if(sourceMachType === 'dryer') job = this.dryers[sourceMachId].job;
        else job = this.queue.find(j => j.id === jobId);

        if (!job) return;

        const typeName = targetType === 'washer' ? 'Lavadora' : 'Secadora';
        if (title) {
            title.innerHTML = `<i class="ph ph-arrows-out-cardinal"></i> Asignar a ${typeName}`;
        }

        details.textContent = `Cliente: ${job.client} - Carga ${job.subloadIndex} (${job.fabric})`;

        optsContainer.innerHTML = '';
        const dict = targetType === 'washer' ? this.washers : this.dryers;

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
            this.washers[this.sourceMachId].job = null;
            clearInterval(this.washers[this.sourceMachId].interval);
            
            if(job.cycleTrack) {
                job.cycleTrack.endedWashAt = Date.now();
                job.cycleTrack.startedDryAt = Date.now();
            }

        } else {
            const qIdx = this.queue.findIndex(j => j.id === this.activeJobId);
            if (qIdx === -1) return;
            job = this.queue.splice(qIdx, 1)[0];
            
            if(!job.cycleTrack) job.cycleTrack = {};
            if (this.activeTargetType === 'washer') {
                job.cycleTrack.startedWashAt = Date.now();
            } else {
                job.cycleTrack.startedDryAt = Date.now();
            }
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
                this.renderMachines();
                this.saveState();
            }
        }, 60000);

        this.closeModal();
        this.updateQueueBoard();
        this.renderMachines();
        this.saveState();
    }

    finishJob(dryerId) {
        this.playFinishSound();
        clearInterval(this.dryers[dryerId].interval);
        const job = this.dryers[dryerId].job;
        
        if (job && job.orderId && this.orders[job.orderId]) {
            this.orders[job.orderId].finishedSubloads++;
        }

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
        const realWash = job.cycleTrack?.startedWashAt && job.cycleTrack?.endedWashAt 
            ? Math.round((job.cycleTrack.endedWashAt - job.cycleTrack.startedWashAt) / 60000) 
            : job.washTime; 
        const realDry = job.cycleTrack?.startedDryAt && job.cycleTrack?.endedDryAt
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
            document.getElementById('edit-job-modal').classList.add('active');
        }
    }

    closeEditModal() {
        this.editMachType = null;
        this.editMachId = null;
        document.getElementById('edit-job-modal').classList.remove('active');
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

        Object.values(this.orders).forEach(order => {
            if (order.finishedSubloads > 0) {
                foldingCardsCount++;
                const isComplete = order.finishedSubloads === order.totalSubloads;
                
                let pipsHTML = '';
                for(let p=0; p<order.totalSubloads; p++) {
                    pipsHTML += `<div class="pip ${p < order.finishedSubloads ? 'done' : ''}"></div>`;
                }

                if (!isComplete) {
                    listEl.innerHTML += `
                        <div class="job-card folding-card folding-waiting">
                            <div class="job-card-header">
                                <div class="job-card-title-group">
                                    <span class="job-client-name">${order.client}</span>
                                    <span class="job-order-badge">[${order.id}]</span>
                                </div>
                                <span class="job-badge" style="color:var(--state-yellow); border-color:var(--state-yellow-border);">EN ESPERA</span>
                            </div>
                            <div class="order-status-bar">${pipsHTML}</div>
                            <div class="folding-subtext" style="color:var(--state-yellow);">
                                <i class="ph ph-spinner ph-spin"></i> Falta terminar ${order.totalSubloads - order.finishedSubloads} carga(s) para doblar.
                            </div>
                        </div>
                    `;
                } else {
                    listEl.innerHTML += `
                        <div class="job-card folding-card folding-ready">
                            <div class="job-card-header">
                                <div class="job-card-title-group">
                                    <span class="job-client-name">${order.client}</span>
                                    <span class="job-order-badge">[${order.id}]</span>
                                </div>
                                <span class="job-badge" style="color:var(--state-red); border-color:var(--state-red-border); background:var(--state-red-bg);">¡LISTO!</span>
                            </div>
                            <div class="order-status-bar">${pipsHTML}</div>
                            <div class="folding-subtext">
                                Listo para doblar y empacar.
                            </div>
                            <div class="job-card-actions" style="margin-top:0.4rem;">
                                <button class="action-btn btn-deliver" onclick="app.deliverOrder('${order.id}')">
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

        activeWashers = activeWashers || 1;
        activeDryers = activeDryers || 1;

        const totalTrafficMins = Math.round((queueWashMins + runningWashMins) / activeWashers + (queueDryMins + runningDryMins) / activeDryers);

        let orderWashTime = 0; let orderDryTime = 0;
        const cards = document.querySelectorAll('.subload-card');
        cards.forEach(card => {
            const wBase = parseInt(card.querySelector('.est-wash')?.value) || 0;
            const dBase = parseInt(card.querySelector('.est-dry')?.value) || 0;
            const weightInput = parseFloat(card.querySelector('.weight-input')?.value) || 0;
            
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

        let jumps = 0;
        while (completionDate.getHours() >= 16 || completionDate.getHours() < 7) {
            jumps++;
            if(jumps > 30) break;
            
            if (completionDate.getHours() >= 16) {
                const diffInMins = ((completionDate.getHours() - 16) * 60) + completionDate.getMinutes();
                completionDate.setDate(completionDate.getDate() + 1);
                completionDate.setHours(7, diffInMins, 0, 0);
            } else if (completionDate.getHours() < 7) {
                const diffInMins = (completionDate.getHours() * 60) + completionDate.getMinutes();
                completionDate.setHours(7, diffInMins, 0, 0);
            }
        }
        
        const diffInDays = Math.floor((completionDate.getTime() - new Date().setHours(0,0,0,0)) / (1000 * 60 * 60 * 24));
        
        let dayStr = "";
        if (diffInDays === 0) dayStr = "Hoy ";
        else if (diffInDays === 1) dayStr = "Mañana ";
        else {
            const formatter = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
            dayStr = formatter.format(completionDate) + " - ";
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
            badgeEl.innerHTML = `<i class="ph ph-clock"></i> Entrega: ${dayStr}${timeStr}`;
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
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;"><i class="ph ph-spinner ph-spin"></i> Cargando Historial...</td></tr>';

        try {
            const { data, error } = await this.supabase
                .from('job_history')
                .select('*')
                .order('completed_at', { ascending: false })
                .limit(50);
            
            if(error) throw error;
            
            tbody.innerHTML = '';
            if(data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-muted)">Aún no hay registros de cargas terminadas.</td></tr>';
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
                        <td style="font-weight:700; color:var(--text-primary)">${row.order_id}</td>
                        <td>#${row.subload}</td>
                        <td>${row.fabric}</td>
                        <td>${row.weight} lbs</td>
                        <td>${row.est_wash}m / <strong>${row.real_wash}m</strong></td>
                        <td>${row.est_dry}m / <strong>${row.real_dry}m</strong></td>
                        <td><span class="${diffClass}">${diffText}</span></td>
                        <td><button onclick="app.deleteHistoryRecord('${row.id}')" style="background:transparent; border:none; color:var(--state-red); cursor:pointer;" title="Borrar Registro"><i class="ph ph-trash"></i></button></td>
                    </tr>
                `;
            });
            
        } catch(err) {
            console.error(err);
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--state-red)">Error cargando Supabase. Revisa la consola o si creaste la tabla.</td></tr>';
        }
    }

    exitAdmin() {
        document.getElementById('analytics-view').style.display = 'none';
        document.getElementById('dashboard-view').style.display = 'grid';
    }

    async deleteHistoryRecord(id) {
        if(!confirm("¿Estás seguro de querer borrar este registro del historial?")) return;
        try {
            const { error } = await this.supabase.from('job_history').delete().eq('id', id);
            if(error) throw error;
            this.showAnalytics();
        } catch(err) { console.error(err); alert("Error borrando el registro."); }
    }

    async exportToExcel() {
        try {
            const { data, error } = await this.supabase.from('job_history').select('*').order('completed_at', { ascending: false });
            if(error) throw error;
            if(!data || data.length === 0) return alert("No hay datos para exportar");

            let csvContent = "data:text/csv;charset=utf-8,";
            csvContent += "Fecha,Orden,Carga_Num,Tela,Peso_lbs,Lavado_Estimado,Lavado_Real,Secado_Estimado,Secado_Real,Desviacion_Total_Minutos\n";
            
            data.forEach(row => {
               const dateObj = new Date(row.completed_at);
               const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
               const diff = (row.real_wash - row.est_wash) + (row.real_dry - row.est_dry);
               
               csvContent += `"${dateStr}","${row.order_id}",${row.subload},"${row.fabric}",${row.weight},${row.est_wash},${row.real_wash},${row.est_dry},${row.real_dry},${diff}\n`;
            });

            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `WashFlow_Analytics_${new Date().toLocaleDateString().replace(/\//g,'-')}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch(err) { console.error(err); alert("Falló la exportación."); }
    }

    toggleCustomerManager() {
        const panel = document.getElementById('customer-manager');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }

    async processBulkImport() {
        const raw = document.getElementById('import-names-area').value.trim();
        if (!raw) return;

        let names = raw.split(/[\n,]+/).map(n => n.trim()).filter(n => n.length > 0);
        names = [...new Set(names)];

        if (confirm(`¿Importar ${names.length} clientes únicos?`)) {
            await this.importCustomers(names);
            document.getElementById('import-names-area').value = '';
            this.toggleCustomerManager();
        }
    }
}

const app = new WashFlowApp();
