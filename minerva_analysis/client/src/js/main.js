/**
 * main.js Initializes main client/interface setup, and distributes events to respective views
 */


//EVENTHANDLER
const eventHandler = new SimpleEventHandler(d3.select('body').node());
const datasource = flaskVariables.datasource;

//VIEWS
let seaDragonViewer;
let channelList;
let csv_gatingList;

//DATA MANAGEMENT
let dataLayer;
let config;
let dataSrcIndex = 0; // dataset id

//CHANNELS
let imageChannels = {}; // lookup table between channel id and channel name (for image viewer)
let imageChannelsIdx = {};

//COLORS
let colorScheme;

//OTHER SETTINGS
document.getElementById("openseadragon")
    .addEventListener('contextmenu',
            event => event.preventDefault()); //Disable right clicking on element

//LOAD DATA
// Data prevent caching on the config file, as it may have been modified
d3.json(`/config?t=${Date.now()}`).then(function (config) {
    this.config = config;
    return init(config[datasource])
});

//INITS

/**
 * Init all views.
 *
 * @param conf - The configuration json file
 */
async function init(conf) {

    config = conf;
    //maximum selections
    config.maxSelections = 4;
    config.extraZoomLevels = 3;
    //channel information
    for (let idx = 0; idx < config["imageData"].length; idx++) {
        imageChannels[config["imageData"][idx].fullname] = idx;
        let name = config["imageData"][idx].name
        if (name !== 'Area') {
            imageChannelsIdx[idx] = name;
        }
    }

    //initialize metadata
    dataLayer = new DataLayer(config, imageChannels);
    const numericData = new NumericData(config, dataLayer);
    const columns = await dataLayer.getChannelNames(true);
    const imgMetadata = await dataLayer.getMetadata(); 

    //Create channel panels
    channelList = new ChannelList(config, columns, dataLayer, eventHandler);
    csv_gatingList = new CSVGatingList(config, columns, dataLayer, eventHandler);

    //Create image viewer
    const imageArgs = [ imgMetadata, numericData, eventHandler ];
    seaDragonViewer = new ImageViewer(config, ...imageArgs);
    viewerManager = new ViewerManager(seaDragonViewer, channelList);

    //Initialize with database description
    const [dd, {ids, centers}] = await Promise.all([
        dataLayer.getDatabaseDescription(),
        numericData.loadCells()
    ])
    channelList.init(dd);
    csv_gatingList.init(dd);
    const imageInit = [
        viewerManager,
        channelList,
        csv_gatingList,
        centers,
        ids
    ];
    await Promise.all([
        dataLayer.init(),
        seaDragonViewer.init(...imageInit)
    ]);
}

//EVENT HANDLING

/**
 * Listen to Color Transfer Change Events and forwards it to respective views.
 *
 * @param d - The color map object
 */
const actionColorTransferChange = (d) => {

    //map to full name
    d.name = dataLayer.getFullChannelName(d.name);
    // d3.select('body').style('cursor', 'progress');
    seaDragonViewer.updateChannelColors(d.name, d.color, d.type);
    // d3.select('body').style('cursor', 'default');
}
eventHandler.bind(ChannelList.events.COLOR_TRANSFER_CHANGE, actionColorTransferChange);

/**
 * Listen to Render Mode Events and forwards it to respective views.
 *
 * @param d - The render mode object
 */
const actionRenderingModeChange = (d) => {
    seaDragonViewer.updateRenderingMode(d);
}
eventHandler.bind(ImageViewer.events.renderingMode, actionRenderingModeChange);

/**
 * Listen to Channels set for Rendering and forwards it to respective views.
 *
 * @param d - The channel package object
 */
const actionChannelsToRenderChange = (d) => {
    d3.select('body').style('cursor', 'progress');

    //map to full name
    d.name = dataLayer.getFullChannelName(d.name);

    //send to image viewer
    const action = ["remove", "add"][+d.status];
    seaDragonViewer.updateActiveChannels(d.name, action);

    d3.select('body').style('cursor', 'default');
}
eventHandler.bind(ChannelList.events.CHANNELS_CHANGE, actionChannelsToRenderChange);

/**
 * Listen to regional or single cell selection.
 *
 * @param d - The selections
 */
const actionImageClickedMultiSel = (d) => {
    d3.select('body').style('cursor', 'progress');
    // add newly clicked item to selection
    if (!Array.isArray(d.item)) {
        dataLayer.addToCurrentSelection(d.item, true, d.clearPriors);
        updateSeaDragonSelection([d.item]);
    } else {
        dataLayer.addAllToCurrentSelection(d.item);
        updateSeaDragonSelection(d.item);
    }
    d3.select('body').style('cursor', 'default');
}
eventHandler.bind(ImageViewer.events.imageClickedMultiSel, actionImageClickedMultiSel);

/**
 * Listen to Channel Select Click Events.
 *
 * @param sels - The selected/deselected channels
 */
const channelSelect = async (sels) => {
    updateSeaDragonSelection();
    let channelCells = await dataLayer.getChannelCellIds(sels);
    dataLayer.addAllToCurrentSelection(channelCells);
}
eventHandler.bind(ChannelList.events.CHANNEL_SELECT, channelSelect);

/**
 * Listens to and updates based on selection changes (specific for seadragon).
 *
 * @param ids - list of selected ids
 */
function updateSeaDragonSelection(ids=[]) {
    const { idField } = this.config[datasource].featureData[0];
    seaDragonViewer.pickedIds = ids.map(v => v[idField]);
    seaDragonViewer.forceRepaint();
}

/**
 * Listens to and updates based on selection changes (specific for seadragon).
 *
 * @param packet - gating filter
 */
const gatingBrushEnd = async (packet) => {
    return updateSeaDragonSelection(); // TODO, compatibility
    /*
    const start_keys = [
        this.config[datasource].featureData[0].idField,
        this.config[datasource].featureData[0].xCoordinate,
        this.config[datasource].featureData[0].yCoordinate
    ];
    // Toggle these methods with centroids on/off ui
    if (csv_gatingList.eval_mode === 'and') {
        // AND
        gatedCells = await dataLayer.getGatedCellIds(packet, start_keys);
    } else {
        // OR
        gatedCells = await dataLayer.getGatedCellIdsCustom(packet, start_keys);
    }
    // Update selection
    dataLayer.addAllToCurrentSelection(gatedCells);
    */
}
eventHandler.bind(CSVGatingList.events.GATING_BRUSH_END, gatingBrushEnd);

eventHandler.bind(CSVGatingList.events.GATING_BRUSH_MOVE, () => {
    updateSeaDragonSelection();
});

eventHandler.bind(ChannelList.events.BRUSH_MOVE, (d) => {
    const fullName = dataLayer.getFullChannelName(d.name);
    seaDragonViewer.updateChannelRange(fullName, d.dataRange[0], d.dataRange[1]);
});

/**
 * Reset the gating list to inital values.
 */
const reset_lists = () => {
    csv_gatingList.resetGatingList();
    channelList.resetChannelList();
    seaDragonViewer.forceRepaint();
}
eventHandler.bind(ChannelList.events.RESET_LISTS, reset_lists);

const add_scalebar = () => {
    seaDragonViewer.addScaleBar();
    seaDragonViewer.forceRepaint();
}
eventHandler.bind(ImageViewer.events.addScaleBar, add_scalebar);
