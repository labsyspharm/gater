//todo add crossfilter stuff here... build some lensingFilters and sorters for individual and combined dimensions

class DataLayer {

    constructor(config, imageChannels) {
        var that = this;
        //vars and consts
        this.config = config;
        //all image channels
        this.imageChannels = imageChannels;
        //selections
        this.currentSelection = new Set();
        //x,z coords
        this.x = this.config["featureData"][dataSrcIndex]["xCoordinate"];
        this.y = this.config["featureData"][dataSrcIndex]["yCoordinate"];
        this.phenotypes = [];
    }

    async init() {
        try {
            let response = await fetch('/init_database?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            this.phenotypes = await this.getPhenotypes();

        } catch (e) {
            console.log("Error Initializing Dataset", e);
        }
    }

    async getRow(row) {
        try {
            let response = await fetch('/get_database_row?' + new URLSearchParams({
                row: row,
                datasource: datasource
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Row", e);
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

    async getColorScheme(refresh = false) {
        try {
            let response = await fetch('/get_color_scheme?' + new URLSearchParams({
                datasource: datasource,
                refresh: refresh
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Sample Row", e);
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

    async getUploadedGatingCsvValues() {
        try {
            let response = await fetch('/get_uploaded_gating_csv_values?' + new URLSearchParams({
                datasource: datasource
            }))
            let response_data = await response.json();
            return response_data;
        } catch (e) {
            console.log("Error Getting Uploaded Gates", e);
        }
    }

    downloadGatingCSV(channels, selections, fullCsv = false) {
        let form = document.createElement("form");
        form.action = "/download_gating_csv";

        form.method = "post";

        let fullCsvElemment = document.createElement("input");
        fullCsvElemment.type = "hidden";
        fullCsvElemment.value = _.toString(fullCsv);
        fullCsvElemment.name = "fullCsv";
        form.appendChild(fullCsvElemment);

        let selectionsElement = document.createElement("input");
        selectionsElement.type = "hidden";
        selectionsElement.value = JSON.stringify(selections);
        selectionsElement.name = "filter";
        form.appendChild(selectionsElement);

        let channelsElement = document.createElement("input");
        channelsElement.type = "hidden";
        channelsElement.value = JSON.stringify(channels);
        channelsElement.name = "channels";
        form.appendChild(channelsElement);

        let datasourceElement = document.createElement("input");
        datasourceElement.type = "hidden";
        datasourceElement.value = datasource;
        datasourceElement.name = "datasource";
        form.appendChild(datasourceElement);
        document.body.appendChild(form);
        form.submit()

    }

    async getColumnDistributions(columns) {
        try {
            let response = await fetch('/get_column_distributions?' + new URLSearchParams({
                columns: columns,
                datasource: datasource
            }))
            let distributions = await response.json();
            return distributions;
        } catch (e) {
            console.log("Error Getting Nearest Cell", e);
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

    async submitGatingUpload(formData) {
        try {
            formData.append('datasource', datasource);
            let response = await fetch('/upload_gates', {
                method: "POST",
                body: formData
            })
            let cell = await response.json();
            return cell;
        } catch (e) {
            console.log("Error Getting Submitting Form Upload", e);
        }
    }

    async getGatedCellIds(filter) {
        try {
            let response = await fetch('/get_gated_cell_ids?' + new URLSearchParams({
                filter: JSON.stringify(filter),
                datasource: datasource
            }))
            let cellIds = await response.json();
            return cellIds;
        } catch (e) {
            console.log("Error Getting Gated Cell Ids", e);
        }
    }

    async getGatedCellIdsCustom(filter) {
        try {
            // const start = performance.now()
            let response = await fetch('/get_gated_cell_ids_custom?' + new URLSearchParams({
                filter: JSON.stringify(filter),
                datasource: datasource
            }))
            let cellIds = await response.json();
            // const end = performance.now()
            // console.log(end - start)
            // console.log(cellIds)
            return cellIds;
        } catch (e) {
            console.log("Error Getting Gated Cell Ids", e);
        }
    }

    async getDatabaseDescription() {
        try {
            let response = await fetch('/get_database_description?' + new URLSearchParams({
                datasource: datasource
            }))
            let description = await response.json();
            return description;
        } catch (e) {
            console.log("Error Getting DB Description", e);
        }
    }

    async getNeighborhood(maxDistance, x, y) {
        try {
            let response = await fetch('/get_neighborhood?' + new URLSearchParams({
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

    async getNeighborhoodForCell(maxDistance, selectedCell) {
        return this.getNeighborhood(maxDistance, selectedCell[this.x], selectedCell[this.y]);
    }

    getCurrentSelection() {
        return this.currentSelection;
    }

    clearCurrentSelection() {
        this.currentSelection.clear();
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
        this.currentSelection.add(item);

        // console.log('current selection size:', this.currentSelection.size);
        if (this.currentSelection.size > 0) {
            // console.log('id: ', this.currentSelection.values().next().value.id);
        }
    }


    addAllToCurrentSelection(items, allowDelete, clearPriors) {
        // console.log("update current selection")
        var that = this;
        that.currentSelection = new Set(items);
        // console.log("update current selection done")
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

}
