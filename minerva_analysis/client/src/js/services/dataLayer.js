//todo add crossfilter stuff here... build some lensingFilters and sorters for individual and combined dimensions

class DataLayer {

    constructor(config, imageChannels) {
        var that = this;
        //vars and consts
        this.config = config;
        //all image channels
        this.imageChannels = imageChannels;

        this.imageBitRange = [0, 65536];
        //selections
        this.currentSelection = new Map();
        this.currentRawSelection = {};
        //x,z coords
        this.x = this.config["featureData"][dataSrcIndex]["xCoordinate"];
        this.y = this.config["featureData"][dataSrcIndex]["yCoordinate"];
        this.phenotypes = [];
        this.defaultOrder = []
        this.neighborhoodStats = null;
    }

    async init() {
        try {
            let response = await fetch('/init_datasource?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            this.phenotypes = await this.getPhenotypes();
            this.fullNeighborhoods = await this.getAllCells();
            this.defaultOrder = await this.getAxisOrder();


        } catch (e) {
            console.log("Error Initializing Dataset", e);
        }
    }

    async getCells(ids, linkedDataset = null, isImage = false) {
        try {
            let response = await fetch('/get_cells', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        elem: {
                            'ids': ids.points
                        },
                        mode: mode,
                        linkedDataset: linkedDataset,
                        isImage: isImage,
                    })
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Cells", e);
        }
    }


    async getAllCells() {
        try {
            let response = await fetch('/get_all_cells', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        mode: mode
                    })
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting All Cells", e);
        }
    }

    async getChannelCellIds(sels) {
        try {
            let response = await fetch('/get_channel_cell_ids?' + new URLSearchParams({
                filter: JSON.stringify(sels),
                datasource: datasource
            }))
            let cellIds = await response.json();
            return cellIds;
        } catch (e) {
            console.log("Error Getting Channel Cell Ids", e);
        }
    }

    async getChannelNames(shortNames = true) {
        try {
            let response = await fetch('/get_channel_names?' + new URLSearchParams({
                datasource: datasource,
                shortNames: shortNames
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Sample Row", e);
        }
    }

    async getColorScheme() {
        try {
            let response = await fetch('/get_color_scheme?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Color Scheme Row", e);
        }
    }

    async getPhenotypes() {
        try {
            let response = await fetch('/get_phenotypes?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Phenotypes", e);
        }
    }

    async getHeatmapData(plotName) {
        try {
            let selection = null;
            if (plotName != "overall") {
                selection = [...this.getCurrentSelection().keys()]
            }
            let response = await fetch('/get_heatmap_data', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        selectionIds: selection
                    })
            });
            let heatmapData = await response.json();
            return heatmapData;
        } catch (e) {
            console.log("Error Getting Heatmap Data", e);
        }
    }

    async getNeighborhoods() {
        try {
            let response = await fetch('/get_neighborhood_list?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Neighborhoods", e);
        }
    }

    async getAllNeighborhoodStats() {
        try {
            let response = await fetch('/get_all_neighborhood_stats?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting All Neighborhoods", e);
        }
    }

    async editNeighborhood(id, editField, editValue) {
        try {
            let response = await fetch('/edit_neighborhood', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        elem: {
                            'id': id,
                            'editField': editField,
                            'editValue': editValue
                        }
                    })
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Editing Neighborhood", e);
        }
    }

    async deleteNeighborhood(id) {
        try {
            let response = await fetch('/delete_neighborhood', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        elem: {
                            'id': id
                        }
                    })
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Deleting Neighborhood", e);
        }
    }

    async getNeighborhood(id) {
        try {
            let response = await fetch('/get_neighborhood', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        elem: {
                            'id': id
                        }
                    })
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Neighborhood", e);
        }
    }

    async saveNeighborhood() {
        const self = this;
        try {
            let response = await fetch('/save_neighborhood', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        selection: self.getCurrentRawSelection(),
                        source: "User Generated"
                    }
                )
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Saving Neighborhood", e);
        }
    }


    async saveLasso(polygon) {
        const self = this;
        try {
            let response = await fetch('/save_lasso', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        polygon: polygon
                    }
                )
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Saving Lasso", e);
        }
    }

    async getNearestCell(point_x, point_y) {
        try {
            let response = await fetch('/get_nearest_cell?' + new URLSearchParams({
                point_x: point_x,
                point_y: point_y,
                datasource: datasource
            }))
            let cell = await response.json();
            return cell;
        } catch (e) {
            console.log("Error Getting Nearest Cell", e);
        }
    }

    async getIndividualNeighborhood(maxDistance, x, y) {
        try {
            let response = await fetch('/get_individual_neighborhood?' + new URLSearchParams({
                point_x: x,
                point_y: y,
                max_distance: maxDistance,
                datasource: datasource
            }))
            let neighborhood = await response.json();
            return neighborhood;
        } catch (e) {
            console.log("Error Getting Nearest Cell", e);
        }
    }

    async getClusterCells() {
        try {
            let response = await fetch('/get_cluster_cells?' + new URLSearchParams({
                datasource: datasource
            }))
            let clusterCells = await response.json();
            return clusterCells;
        } catch (e) {
            console.log("Error Getting Nearest Cell", e);
        }
    }

    async getCellsInPolygon(points, similar = false, embedding = false) {
        try {
            let response = await fetch('/get_cells_in_polygon?' + new URLSearchParams({
                datasource: datasource,
                points: JSON.stringify(points),
                similar_neighborhood: similar,
                embedding: embedding
            }))
            let cells = await response.json();
            return cells;
        } catch (e) {
            console.log("Error Getting Polygon Cells", e);
        }
    }

    async getSimilarNeighborhoodToSelection(similarity) {
        try {
            searching = true;
            let selectionIds = {};
            if (mode === 'single') {
                selectionIds[datasource] = _.map(this.getCurrentRawSelection().cells, e => e.id);
            } else if (mode === 'multi') {
                _.forEach(this.getCurrentRawSelection(), (val, key) => {
                    if (key !== 'selection_ids' && key !== 'composition_summary') {
                        selectionIds[key] = _.map(val.cells, e => e.id);
                    }
                })
            }
            let response = await fetch('/get_similar_neighborhood_to_selection', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        similarity: similarity,
                        selectionIds: selectionIds,
                        mode: mode
                        // selectionIds: [...this.getCurrentSelection().keys()]
                    })
            });
            let cells = await response.json();
            store('neighborhoodQuery', cells['neighborhood_query'])
            return cells;
        } catch (e) {
            console.log("Error Getting Similar Neighborhood", e);
        }
    }

    async findSimilarNeighborhoods(data, similarity) {
        try {
            searching = true;
            let response = await fetch('/find_custom_neighborhood', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        // neighborhoodComposition: data,
                        neighborhoodComposition: JSON.parse('{"Alveolar MAC":{"key":"Alveolar MAC","short":"Alveolar MAC","value":0.025225006551154755,"index":0},"B":{"key":"B","short":"B","value":0.04834738037493428,"index":1},"DC":{"key":"DC","short":"DC","value":0.08697262570216543,"index":2},"Epithelial":{"key":"Epithelial","short":"Epithelial","value":0.13859822901267488,"index":3},"Immune":{"key":"Immune","short":"Immune","value":0.16140646499499245,"index":4},"Lymphoid":{"key":"Lymphoid","short":"Lymphoid","value":0.0071996742745285185,"index":5},"Myeloid":{"key":"Myeloid","short":"Myeloid","value":0.011748071763574433,"index":6},"NK_L":{"key":"NK_L","short":"NK_L","value":0,"index":7},"NK_M":{"key":"NK_M","short":"NK_M","value":0.0016209938796884365,"index":8},"Neutrophil":{"key":"Neutrophil","short":"Neutrophil","value":0.010232367634344021,"index":9},"Other":{"key":"Other","short":"Other","value":0.19022244680884706,"index":10},"T":{"key":"T","short":"T","value":0.0010842082272883705,"index":11},"T cytotox":{"key":"T cytotox","short":"T cytotox","value":0.03445468430184308,"index":12},"T helper":{"key":"T helper","short":"T helper","value":0.13122538866665834,"index":13},"T reg":{"key":"T reg","short":"T reg","value":0.09822229630185476,"index":14},"TAM":{"key":"TAM","short":"TAM","value":0.037827708551590435,"index":15},"undefined":{"key":"undefined","short":"undefined","value":0.015612452953860797,"index":16}}'),
                        similarity: similarity,
                        mode: mode
                    })
            });
            let cells = await response.json();
            store('neighborhoodQuery', cells['neighborhood_query'])
            return cells;
        } catch (e) {
            console.log("Error Getting Custom Neighborhood", e);
        }
    }

    async getScatterplotData() {
        try {
            let response = await fetch('/get_scatterplot_data?' + new URLSearchParams({
                datasource: datasource,
                mode: mode
            }))
            let scatterplotData = await response.json();
            return scatterplotData;
        } catch (e) {
            console.log("Error Getting Nearest Cell", e);
        }
    }

    async customCluster(numClusters) {
        try {
            let response = await fetch('/custom_cluster?' + new URLSearchParams({
                datasource: datasource,
                numClusters: numClusters

            }))
            let customClusters = await response.json();
            return customClusters;
        } catch (e) {
            console.log("Error Getting Custom Clusters", e);
        }
    }

    async getNeighborhoodForCell(maxDistance, selectedCell) {
        return this.getIndividualNeighborhood(maxDistance, selectedCell[this.x], selectedCell[this.y]);
    }

    getCurrentSelection() {
        return this.currentSelection;
    }

    getCurrentRawSelection() {
        return this.currentRawSelection;
    }

    clearCurrentSelection() {
        this.currentSelection.clear();
        this.currentRawSelection.clear();

    }

    getImageBitRange(float = false) {
        const self = this;
        if (!float) {
            return self.imageBitRange;
        } else {
            return [0.0, 1.0];
        }
    }

    addToCurrentSelection(item, allowDelete, clearPriors) {

        // delete item on second click
        if (allowDelete && this.currentSelection.has(item)) {
            this.currentSelection.delete(item);
            if (clearPriors) {
                this.currentSelection.clear();
            }

            // console.log('current selection size:', this.currentSelection.size);
            if (this.currentSelection.size > 0) {
                // console.log('id: ', this.currentSelection.values().next().value.id);
            }
            return;
        }

        // clear previous items
        if (clearPriors) {
            this.currentSelection.clear();
        }

        // add new item
        this.currentSelection.set(item.id, item);

        // console.log('current selection size:', this.currentSelection.size);
        if (this.currentSelection.size > 0) {
            // console.log('id: ', this.currentSelection.values().next().value.id);
        }
    }

    addAllToCurrentSelection(items, allowDelete, clearPriors) {
        // console.log("update current selection")
        var that = this;
        if (mode == 'single') {
            that.currentSelection = new Map(_.get(items, 'cells', items).map(i => [i.CellID - 1 || i.id, i]));
        } else {
            let multiImageSelection = {}
            Object.entries(items).forEach(([key, value], index) => {
                if (value?.cells) {
                    multiImageSelection[key] = new Map(value?.cells.map(i => [i.id || i.CellID - 1, i]));
                }
            })
            that.currentSelection = multiImageSelection;
        }
        that.currentRawSelection = items;
        // console.log("update current selection done")
    }

    switchViewMode(singleCellMode) {
        const self = this;
        const title = document.getElementById('cell_view_title');
        if (singleCellMode) {
            self.currentSelection = new Map(_.get(self.getCurrentRawSelection(), 'cells').map(i => [i.id, i]));
        } else {
            self.currentSelection = new Map(_.map(_.get(self.getCurrentRawSelection(), 'neighbors'), elem => {
                let phenotype = _.get(self.currentSelection.get(elem), 'phenotype') || _.get(self.getCurrentRawSelection(), `[neighbor_phenotypes][${elem}]`)
                return [elem, {'phenotype': phenotype}];
            }));
        }

    }

    isImageFeature(key) {
        if (this.imageChannels.hasOwnProperty(key)
            && key != 'CellId' && key != 'id' && key != 'CellID' && key != 'ID' && key != 'Area') {
            return true;
        }
        return false;
    }

    getShortChannelName(fullname) {
        var shortname = fullname;
        this.config["imageData"].forEach(function (channel) {
            if (channel.fullname == fullname) {
                shortname = channel.name;
            }
        });
        return shortname;
    }

    getFullChannelName(shortname) {
        var fullname = shortname;
        this.config["imageData"].forEach(function (channel) {
            if (channel.name == shortname) {
                fullname = channel.fullname;
            }
        });
        return fullname;
    }


    async getNeighborhoodByPhenotype(phenotype, selection = null) {

        try {
            let selectionIds = null;
            if (selection) {
                selectionIds = [...this.getCurrentSelection().keys()]
            }
            let response = await fetch('/get_neighborhood_by_phenotype', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        phenotype: phenotype,
                        selectionIds: selectionIds
                    })
            });
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Cells By Phenotype", e);
        }
    }

    async getMetadata() {
        try {
            let response = await fetch('/get_ome_metadata?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Metadata", e);
        }
    }

    async getContourLines() {
        try {
            let response = await fetch('/get_contour_lines', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        selectionIds: _.map(this.getCurrentRawSelection().cells, e => e.id)
                    })
            });
            let paths = await response.json();
            return paths;
        } catch (e) {
            console.log("Error Getting Paths", e);
        }
    }

    async getRelatedImageData() {
        try {
            let response = await fetch('/get_related_image_data?' + new URLSearchParams({
                datasource: datasource,
                mode: mode,
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Related Images", e);
        }
    }

    async getImageSearchResults(dataset) {
        try {
            let response = await fetch('/get_image_search_results?' + new URLSearchParams({
                linkedDatasource: dataset,
                datasource: datasource,
                neighborhoodQuery: JSON.stringify(store('neighborhoodQuery'))
            }))
            let cells = await response.json();
            return cells;
        } catch (e) {
            console.log("Error Getting Image Search Results", e);
        }
    }

    async getAxisOrder() {
        try {
            let response = await fetch('/get_axis_order?' + new URLSearchParams({
                datasource: datasource
            }))
            let cells = await response.json();
            return cells;
        } catch (e) {
            console.log("Error Getting Axis Ordering", e);
        }
    }

    async applyNeighborhoodQuery() {
        try {
            if (!store('neighborhoodQuery')) {
                return true;
            }
            let response = await fetch('/apply_neighborhood_query', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    {
                        datasource: datasource,
                        neighborhoodQuery: store('neighborhoodQuery')
                    })
            });
            let cells = await response.json();
            return cells;
        } catch (e) {
            console.log("Error Applying Previous Query", e);
        }
    }


}