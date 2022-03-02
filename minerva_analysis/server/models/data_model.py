import numba
from sklearn.neighbors import BallTree
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import MinMaxScaler
from scipy import stats
from numba import prange
import dask.dataframe as dd
import dask.array as da
import math

from sklearn.decomposition import IncrementalPCA
from sklearn.decomposition import PCA
from sqlalchemy import or_
import palettable
import numpy as np
import pandas as pd
from PIL import ImageColor
import json
import os
import io
from pathlib import Path
from ome_types import from_xml
from minerva_analysis import config_json_path
from minerva_analysis.server.utils import pyramid_assemble
import matplotlib.path as mpltPath
import matplotlib.pyplot as plt

from minerva_analysis.server.utils import smallestenclosingcircle
from minerva_analysis.server.models import database_model
from scipy.stats import pearsonr, spearmanr
from KDEpy import FFTKDE
from copy import deepcopy

import time
import pickle
import tifffile as tf
import re
import zarr
from numcodecs import Blosc
from scipy import spatial

from line_profiler_pycharm import profile

ball_tree = None
datasource = None
source = None
config = None
seg = None
channels = None
metadata = None
np_datasource = None


def init(datasource_name):
    load_datasource(datasource_name)


def load_datasource(datasource_name, reload=False):
    global datasource
    global source
    global config
    global seg
    global channels
    global metadata
    global np_datasource
    if source == datasource_name and datasource is not None and reload is False:
        return
    load_config()
    source = datasource_name
    datasource = load_csv(datasource_name)
    np_datasource = load_csv(datasource_name, numpy=True)
    load_ball_tree(datasource_name, reload=reload)
    if config[datasource_name]['segmentation'].endswith('.zarr'):
        seg = zarr.load(config[datasource_name]['segmentation'])
    else:
        seg_io = tf.TiffFile(config[datasource_name]['segmentation'], is_ome=False)
        seg = zarr.open(seg_io.series[0].aszarr())
    channel_io = tf.TiffFile(config[datasource_name]['channelFile'], is_ome=False)
    metadata = get_ome_metadata(datasource_name)
    channels = zarr.open(channel_io.series[0].aszarr())
    init_clusters(datasource_name)


# @profile
def load_csv(datasource_name, numpy=False):
    global config
    numpy_file_name = datasource_name + "_np.npy"
    numpy_path = Path(
        os.path.join(os.getcwd())) / "minerva_analysis" / "data" / "featureData" / numpy_file_name
    if numpy:
        if numpy_path.is_file():
            return np.load(numpy_path, allow_pickle=True)

    csvPath = Path(config[datasource_name]['featureData'][0]['src'])
    df = pd.read_csv(csvPath, index_col=None)
    # df = dd.read_csv(csvPath, assume_missing=True).set_index('id')
    df = df.drop(get_channel_names(datasource_name, shortnames=False), axis=1)
    df['id'] = df.index
    # df['Cluster'] = embedding[:, -1].astype('int32').tolist()
    df['Cluster'] = 0

    if 'CellType' in df.columns:
        df = df.rename(columns={'CellType': 'phenotype'})
    df = df.replace(-np.Inf, 0)
    if numpy:
        # np_df = df.compute().to_numpy()
        np_df = df.to_numpy()
        np.save(str(numpy_path), np_df)
        return np_df
    else:
        return df


def init_clusters(datasource_name):
    global datasource
    global source
    # Select Cluster Stats
    # clusters = np.sort(datasource['Cluster'].unique().compute().tolist())
    clusters = np.sort(datasource['Cluster'].unique().tolist())
    for cluster in clusters:
        # Check if the Cluster is in the DB
        neighborhood = database_model.get(database_model.Neighborhood, datasource=datasource_name, source="Cluster",
                                          cluster_id=int(cluster))
        cluster_cells = None
        # If it's not in the Neighborhood database then create and add it
        if neighborhood is None:
            cluster_cells = datasource.loc[datasource['Cluster'] == cluster]
            # indices = np.array(cluster_cells.index.values.compute().tolist())
            indices = np.array(cluster_cells.index.values.tolist())
            f = io.BytesIO()
            np.save(f, indices)
            neighborhood = database_model.create(database_model.Neighborhood, cluster_id=int(cluster),
                                                 datasource=datasource_name,
                                                 source="Cluster",
                                                 name="Cluster " + str(cluster), cells=f.getvalue())

        else:
            indices = np.load(io.BytesIO(neighborhood.cells))
            cluster_cells = None

        neighborhood_stats = database_model.get(database_model.NeighborhoodStats, neighborhood=neighborhood)

        # Similarly, if the stats are not initialized, let's store them in the DB as well
        if neighborhood_stats is None:
            obj = get_neighborhood_stats(datasource_name, indices, np_datasource, cluster_cells)
            f = io.BytesIO()
            pickle.dump(obj, f)
            neighborhood_stats = database_model.create(database_model.NeighborhoodStats, datasource=datasource_name,
                                                       source="Cluster",
                                                       name="ClusterStats " + str(cluster), stats=f.getvalue(),
                                                       neighborhood=neighborhood)


def get_cluster_cells(datasource_name):
    global datasource
    global source
    clusters = datasource['Cluster'].unique().tolist()
    # clusters = datasource['Cluster'].unique().compute().tolist()
    obj = {}
    for cluster in clusters:
        # Check if the Cluster is in the DB
        neighborhood = database_model.get(database_model.Neighborhood, datasource=datasource_name,
                                          cluster_id=int(cluster))
        neighborhood_stats = database_model.get(database_model.NeighborhoodStats, neighborhood=neighborhood)
        obj[str(cluster)] = pickle.load(io.BytesIO(neighborhood_stats.stats))
    return obj


def get_neighborhood_list(datasource_name):
    filtered_neighborhoods = database_model.filter_all(database_model.Neighborhood,
                                                       or_(database_model.Neighborhood.datasource == datasource_name,
                                                           database_model.Neighborhood.source == "Lasso"))
    return [(neighborhood.id, neighborhood.cluster_id, neighborhood.name, neighborhood.source) for neighborhood in
            filtered_neighborhoods]


def edit_neighborhood(elem, datasource_name):
    database_model.edit(database_model.Neighborhood, elem['id'], elem['editField'], elem['editValue'])
    new_neighborhoods = database_model.get_all(database_model.Neighborhood, datasource=datasource_name)
    return [(neighborhood.id, neighborhood.cluster_id, neighborhood.name, neighborhood.source) for neighborhood in
            new_neighborhoods]


def get_neighborhood(elem, datasource_name):
    neighborhood = database_model.get(database_model.Neighborhood, id=elem['id'], datasource=datasource_name)
    neighborhood_stats = database_model.get(database_model.NeighborhoodStats, neighborhood=neighborhood,
                                            datasource=datasource_name)
    if neighborhood_stats:
        return pickle.load(io.BytesIO(neighborhood_stats.stats))
    else:
        return []


def get_all_neighborhood_stats(datasource_name):
    scaler = MinMaxScaler(feature_range=(-1, 1)).fit([[0], [np.max(
        [config[datasource_name]['height'], config[datasource_name]['width']])]])

    def get_stats(neighborhood):
        nonlocal scaler
        neighborhood_stats = database_model.get(database_model.NeighborhoodStats, neighborhood=neighborhood,
                                                datasource=datasource_name)
        if neighborhood_stats is None:
            return {}
        stats = pickle.load(io.BytesIO(neighborhood_stats.stats))
        stats['neighborhood_id'] = neighborhood_stats.neighborhood_id
        stats['name'] = neighborhood_stats.name
        stats['neighborhood_name'] = neighborhood.name
        x_field = config[datasource_name]['featureData'][0]['xCoordinate']
        y_field = config[datasource_name]['featureData'][0]['yCoordinate']
        stats['cells'] = np.array([[elem[x_field], elem[y_field], elem['id']] for elem in stats['cells']])
        stats['cells'] = stats['cells'].astype(float)
        stats['cells'][:, 0:1] = MinMaxScaler(feature_range=(-1, 1)).fit(
            [[0], [config[datasource_name]['width']]]).transform(stats['cells'][:, 0:1])
        stats['cells'][:, 1:2] = MinMaxScaler(feature_range=(-1, 1)).fit(
            [[0], [config[datasource_name]['height']]]).transform(stats['cells'][:, 1:2])
        stats['cells'] = [[elem[0], elem[1], int(elem[2])] for id, elem in enumerate(stats['cells'])]
        return stats

    neighborhoods = database_model.get_all(database_model.Neighborhood, datasource=datasource_name)
    obj = [get_stats(neighborhood) for neighborhood in neighborhoods]
    return obj


def save_lasso(polygon, datasource_name):
    max_cluster_id = database_model.max(database_model.NeighborhoodStats, 'neighborhood_id')
    np_polygon = np.array(polygon['coordinates'])
    f = io.BytesIO()
    np.save(f, np_polygon)
    neighborhood = database_model.create(database_model.Neighborhood, cluster_id=max_cluster_id + 1,
                                         datasource=datasource_name,
                                         source="Lasso",
                                         name="Lasso " + str(max_cluster_id + 1), cells=f.getvalue())
    f = io.BytesIO()
    pickle.dump(polygon['coordinates'], f)
    database_model.create(database_model.NeighborhoodStats, datasource=datasource_name,
                          source=source,
                          name="", stats=f.getvalue(),
                          neighborhood=neighborhood)
    return get_neighborhood_list(datasource_name)


def save_neighborhood(selection, datasource_name, source="Cluster"):
    max_cluster_id = database_model.max(database_model.NeighborhoodStats, 'neighborhood_id')
    indices = np.array([e['id'] for e in selection['cells']])
    f = io.BytesIO()
    np.save(f, indices)
    neighborhood = database_model.create(database_model.Neighborhood, cluster_id=max_cluster_id + 1,
                                         datasource=datasource_name,
                                         source=source,
                                         name="", cells=f.getvalue())
    f = io.BytesIO()
    pickle.dump(selection, f)
    database_model.create(database_model.NeighborhoodStats, datasource=datasource_name,
                          source=source,
                          name="", stats=f.getvalue(),
                          neighborhood=neighborhood)
    return get_neighborhood_list(datasource_name)


def delete_neighborhood(elem, datasource_name):
    database_model.edit(database_model.Neighborhood, elem['id'], 'is_deleted', True)
    new_neighborhoods = database_model.get_all(database_model.Neighborhood, datasource=datasource_name)
    print('Count', len(new_neighborhoods))
    return [(neighborhood.id, neighborhood.cluster_id, neighborhood.name, neighborhood.source) for neighborhood in
            new_neighborhoods]


def get_neighborhood_by_phenotype(datasource_name, phenotype, selection_ids=None):
    global datasource
    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)

    fields = [config[datasource_name]['featureData'][0]['xCoordinate'],
              config[datasource_name]['featureData'][0]['yCoordinate'], 'id']
    if isinstance(phenotype, list):
        cell_ids = datasource.loc[datasource['phenotype'].isin(phenotype)].index.values
    else:
        cell_ids = datasource.loc[datasource['phenotype'] == phenotype].index.values
    if selection_ids is not None:
        cell_ids = np.intersect1d(np.array(selection_ids), cell_ids)
    obj = get_neighborhood_stats(datasource_name, cell_ids, np_datasource, fields=fields)
    return obj


def create_custom_clusters(datasource_name, num_clusters):
    global config
    global datasource
    database_model.delete(database_model.Neighborhood, custom=True)
    database_model.delete(database_model.NeighborhoodStats, custom=True)
    max_cluster_id = database_model.max(database_model.NeighborhoodStats, 'neighborhood_id')

    g_mixtures = GaussianMixture(n_components=num_clusters)
    data = np.load(Path(config[datasource_name]['embedding']))
    # TODO REMOVE CLUSTER HARDCODE
    coords = data[:, 0:2]
    neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
    tes = np.hstack((coords, neighborhoods))
    tes = np.hstack((coords, tes))
    tes = np.hstack((coords, tes))
    tes = np.hstack((coords, tes))
    pcaed_tes = PCA(n_components=3).fit_transform(tes);
    g_mixtures.fit(pcaed_tes)
    clusters = g_mixtures.predict(pcaed_tes)
    # randomly_sampled = np.random.choice(data.shape[0], size=100000, replace=False)
    # g_mixtures.fit(data[randomly_sampled, :-1])
    # clusters = np.zeros((data.shape[0],))
    # for i in range(np.ceil(data.shape[0] / 100000).astype(int)):
    #     bottom = i * 100000
    #     top = min(data.shape[0], (i + 1) * 100000)
    #     clusters[bottom:top] = g_mixtures.predict(data[bottom:top, :2])

    for cluster in np.sort(np.unique(clusters)).astype(int).tolist():
        indices = np.argwhere(clusters == cluster).flatten()
        f = io.BytesIO()
        np.save(f, indices)
        neighborhood = database_model.create(database_model.Neighborhood,
                                             datasource=datasource_name, source="Cluster", custom=True,
                                             cluster_id=max_cluster_id + 1, name="Custom Cluster " + str(cluster),
                                             cells=f.getvalue())

        obj = get_neighborhood_stats(datasource_name, indices, np_datasource)
        f = io.BytesIO()
        pickle.dump(obj, f)

        neighborhood_stats = database_model.create(database_model.NeighborhoodStats, datasource=datasource_name,
                                                   source="Cluster",
                                                   custom=True,
                                                   name="ClusterStats " + str(cluster), stats=f.getvalue(),
                                                   neighborhood=neighborhood)
        max_cluster_id += 1

    return get_neighborhood_list(datasource_name)


def load_config():
    global config
    with open(config_json_path, "r+") as configJson:
        config = json.load(configJson)


def load_ball_tree(datasource_name, reload=False):
    global ball_tree
    global datasource
    global config
    pickled_kd_tree_path = str(
        Path(
            os.path.join(os.getcwd())) / "minerva_analysis" / "data" / datasource_name / "ball_tree.pickle")
    try:
        if os.path.isfile(pickled_kd_tree_path) and reload is False:
            print("Pickled KD Tree Exists, Loading")
            ball_tree = pickle.load(open(pickled_kd_tree_path, "rb"))
            return
    except:
        pass
    print("Creating KD Tree")
    xCoordinate = config[datasource_name]['featureData'][0]['xCoordinate']
    yCoordinate = config[datasource_name]['featureData'][0]['yCoordinate']
    csvPath = Path(config[datasource_name]['featureData'][0]['src'])
    raw_data = pd.read_csv(csvPath)
    points = pd.DataFrame({'x': raw_data[xCoordinate], 'y': raw_data[yCoordinate]})
    ball_tree = BallTree(points, metric='euclidean')
    parent_directory_path = Path(
        os.path.join(os.getcwd())) / "minerva_analysis" / "data" / datasource_name
    # Creates Directory if it doesn't exist
    parent_directory_path.mkdir(parents=True, exist_ok=True)
    pickle.dump(ball_tree, open(pickled_kd_tree_path, 'wb'))


def query_for_closest_cell(x, y, datasource_name):
    global datasource
    global source
    global ball_tree
    if datasource_name != source:
        load_datasource(datasource_name)
    distance, index = ball_tree.query([[x, y]], k=1)
    if distance == np.inf:
        return {}
    #         Nothing found
    else:
        try:
            row = datasource.iloc[index[0]]
            obj = row.to_dict(orient='records')[0]
            if 'phenotype' not in obj:
                obj['phenotype'] = ''
            return obj
        except:
            return {}


# @profile
def get_cells(elem, datasource_name, mode, linked_dataset=None, is_image=False):
    global datasource
    global source
    global config
    fields = [config[datasource_name]['featureData'][0]['xCoordinate'],
              config[datasource_name]['featureData'][0]['yCoordinate'], 'phenotype', 'id']

    if mode == 'multi':
        obj = {'selection_ids': elem['ids']}
        sorted_ids = np.array(sorted(elem['ids']))
        this_time = time.time()
        if 'linkedDatasets' in config[datasource_name]:
            index_sum = 0
            for dataset in config[datasource_name]['linkedDatasets']:
                np_df = load_csv(dataset, numpy=True)
                next_sum = index_sum + len(np_df)
                # next_sum = index_sum + df.shape[0].compute()
                if linked_dataset is not None and is_image is True:
                    if linked_dataset == dataset:
                        obj[dataset] = get_neighborhood_stats(dataset, sorted_ids, np_df, fields=fields,
                                                              compute_neighbors=False)
                        selection_ids = sorted_ids + index_sum
                        obj[dataset]['selection_ids'] = selection_ids
                else:
                    relevant_ids = sorted_ids[np.where((sorted_ids >= index_sum) & (sorted_ids < next_sum))]
                    relevant_ids = relevant_ids - index_sum
                    obj[dataset] = get_neighborhood_stats(dataset, relevant_ids, np_df, fields=fields,
                                                          compute_neighbors=False)
                    print('ranges', index_sum, next_sum)
                index_sum = next_sum
        obj['composition_summary'] = weight_multi_image_neighborhood(obj, datasource_name, len(sorted_ids))
        # Deleting redundant data
        for dataset in config[datasource_name]['linkedDatasets']:
            if 'dataset' in obj:
                del obj[dataset]['composition_summary']['selection_neighborhoods']
                del obj[dataset]['composition_summary']['selection_ids']

        print('Get Cells Multi Time', time.time() - this_time)
    else:
        ids = np.array(elem['ids'], dtype=int)
        obj = get_neighborhood_stats(datasource_name, ids, np_datasource, fields=fields)
    return obj


def weight_multi_image_neighborhood(neighborhood_obj, datasource_name, selection_length):
    global config
    obj = {'weighted_contribution': None, 'selection_neighborhoods': None}
    for dataset in config[datasource_name]['linkedDatasets']:
        if dataset in neighborhood_obj:
            try:
                dataset_weight = len(neighborhood_obj[dataset]['cells']) / selection_length
            except ZeroDivisionError:
                dataset_weight = 0
            if obj['weighted_contribution'] is None:
                obj['weighted_contribution'] = deepcopy(
                    neighborhood_obj[dataset]['composition_summary']['weighted_contribution'])
                obj['selection_neighborhoods'] = neighborhood_obj[dataset]['composition_summary'][
                    'selection_neighborhoods']
                for i, val in enumerate(neighborhood_obj[dataset]['composition_summary']['weighted_contribution']):
                    obj['weighted_contribution'][i][1] *= dataset_weight
            else:
                for i, val in enumerate(neighborhood_obj[dataset]['composition_summary']['weighted_contribution']):
                    obj['weighted_contribution'][i][1] += (val[1] * dataset_weight)
                obj['selection_neighborhoods'] = np.vstack((obj['selection_neighborhoods'],
                                                            neighborhood_obj[dataset]['composition_summary'][
                                                                'selection_neighborhoods']))

    return obj


def get_all_cells(datasource_name, mode):
    global datasource
    global source
    global config
    fields = [config[datasource_name]['featureData'][0]['xCoordinate'],
              config[datasource_name]['featureData'][0]['yCoordinate'], 'phenotype', 'id']
    if mode == 'single':
        neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
        row_sums = neighborhoods.sum(axis=1)
        neighborhoods = neighborhoods / row_sums[:, np.newaxis]
        indices = np.arange(neighborhoods.shape[0])
        selection_neighborhoods = neighborhoods[indices, :]
        sample_size = 5000
        selection_neighborhoods = selection_neighborhoods[
                                  np.random.choice(selection_neighborhoods.shape[0], sample_size, replace=True),
                                  :]
        return {'full_neighborhoods': selection_neighborhoods,
                'selection_ids': indices}
        # obj = get_neighborhood_stats(datasource_name, np.arange(datasource.shape[0]), fields=fields)
    else:
        if 'linkedDatasets' in config[datasource_name]:
            combined_neighborhoods = None
            for dataset in config[datasource_name]['linkedDatasets']:
                neighborhoods = np.load(Path(config[dataset]['neighborhoods']))
                row_sums = neighborhoods.sum(axis=1)
                neighborhoods = neighborhoods / row_sums[:, np.newaxis]
                indices = np.arange(neighborhoods.shape[0])
                selection_neighborhoods = neighborhoods[indices, :]
                sample_size = 400
                selection_neighborhoods = selection_neighborhoods[
                                          np.random.choice(selection_neighborhoods.shape[0], sample_size, replace=True),
                                          :]
                if combined_neighborhoods is None:
                    combined_neighborhoods = selection_neighborhoods
                else:
                    combined_neighborhoods = np.vstack((combined_neighborhoods, selection_neighborhoods))
            return {'full_neighborhoods': combined_neighborhoods}
            # 'selection_ids': indices}

    #     neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
    #     row_sums = neighborhoods.sum(axis=1)
    #     neighborhoods = neighborhoods / row_sums[:, np.newaxis]
    #     selection_neighborhoods = neighborhoods[indices, :]
    #


def get_channel_names(datasource_name, shortnames=True):
    global datasource
    if shortnames:
        channel_names = [channel['name'] for channel in config[datasource_name]['imageData'][1:]]
    else:
        channel_names = [channel['fullname'] for channel in config[datasource_name]['imageData'][1:]]
    return channel_names


def get_channel_cells(datasource_name, channels):
    global datasource
    global source
    global ball_tree

    range = [0, 65536]

    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)

    query_string = ''
    for c in channels:
        if query_string != '':
            query_string += ' and '
        query_string += str(range[0]) + ' < ' + c + ' < ' + str(range[1])
    if query_string == None or query_string == "":
        return []
    query = datasource.query(query_string)[['id']].to_dict(orient='records')
    return query


def get_phenotypes(datasource_name):
    global datasource
    global source
    global config
    try:
        phenotype_field = config[datasource_name]['featureData'][0]['phenotype']
    except KeyError:
        phenotype_field = 'phenotype'
    except TypeError:
        phenotype_field = 'phenotype'

    if datasource_name != source:
        load_datasource(datasource_name)
    if phenotype_field in datasource.columns:
        # return sorted(datasource[phenotype_field].unique().compute().tolist())
        return sorted(datasource[phenotype_field].unique().tolist())
    else:
        return ['']


def get_individual_neighborhood(x, y, datasource_name, r=100, fields=None):
    global datasource
    global source
    global ball_tree
    if datasource_name != source:
        load_datasource(datasource_name)
    index = ball_tree.query_radius([[x, y]], r=r)
    neighbors = index[0]
    # try:
    if fields and len(fields) > 0:
        fields.append('id') if 'id' not in fields else fields
        if len(fields) > 1:
            neighborhood = datasource.iloc[neighbors][fields].to_dict(orient='records')
        else:
            neighborhood = datasource.iloc[neighbors][fields].to_dict()
    else:
        neighborhood = datasource.iloc[neighbors].to_dict(orient='records')

    return neighborhood


# except Error:
#     return {}


def get_number_of_cells_in_circle(x, y, datasource_name, r):
    global source
    global ball_tree
    if datasource_name != source:
        load_datasource(datasource_name)
    index = ball_tree.query_radius([[x, y]], r=r)
    try:
        return len(index[0])
    except:
        return 0


def get_color_scheme(datasource_name):
    labels = get_phenotypes(datasource_name)
    color_scheme = {}
    # http://godsnotwheregodsnot.blogspot.com/2013/11/kmeans-color-quantization-seeding.html
    # colors = palettable.colorbrewer.qualitative.Set3_12.hex_colors
    # colors = ['#00c0c7', '#5144d3', '#723521', '#da3490', '#9089fa', '#c41d1d', '#2780ec', '#6f38b1',
    #           '#e0bf04', '#ab9a95', '#258d6b', '#934270', '#48e26f']
    colors = ["#5648d3", "#a7e831", "#df43b0", "#36e515", "#c047ff", "#789d23", "#b36ab0", "#02531d", "#fbacf6",
              "#683c00", "#54d7eb", "#bc3f3b", "#11e38c", "#830c6f", "#aee39a", "#2c457d", "#fea27a", "#3295e9",
              "#ead624"]
    # # colors.remove('#FDB462')
    # colors.append('#db4ba8')
    # colors.append('#02b72e')
    # colors.append('#2580fe')
    # #db4ba8 #02b72e #2580fe
    for i in range(len(labels)):
        color_scheme[str(labels[i])] = {}
        color_scheme[str(labels[i])]['rgb'] = list(ImageColor.getcolor(colors[i], "RGB"))
        color_scheme[str(labels[i])]['hex'] = colors[i]
        color_scheme[str(i)] = {}
        color_scheme[str(i)]['rgb'] = list(ImageColor.getcolor(colors[i], "RGB"))
        color_scheme[str(i)]['hex'] = colors[i]
    return color_scheme


def get_cluster_labels(datasource_name):
    global config
    data = np.load(Path(config[datasource_name]['embedding']))
    clusters = np.unique(data[:, -1])
    return clusters.astype('int32').tolist()


def get_scatterplot_data(datasource_name, mode):
    global config
    global datasource
    this_time = time.time()
    if 'linkedDatasets' in config[datasource_name] and mode == 'multi':

        combined_embedding = None
        phenotypes_dict = {val: idx for idx, val in enumerate(sorted(datasource.phenotype.unique()))}

        for dataset in config[datasource_name]['linkedDatasets']:
            embedding = np.load(Path(config[dataset]['embedding']))  # TODO Replace
            np_df = load_csv(dataset, numpy=True)
            phenotypes_array = np_df[:, get_column_indices(['phenotype'])]
            for i in range(phenotypes_array.shape[0]):
                phenotypes_array[i, 0] = phenotypes_dict[phenotypes_array[i, 0]]
            phenotypes_array = np.array(phenotypes_array, dtype='uint16')
            if embedding.shape[1] < 3:
                embedding = np.hstack((embedding, np.zeros((embedding.shape[0], 1))))
            embedding = np.hstack((embedding, phenotypes_array))
            if combined_embedding is None:
                combined_embedding = embedding
            else:
                combined_embedding = np.vstack((combined_embedding, embedding))
        data = combined_embedding
        print('Combine Embedding Time', time.time() - this_time, 'and shape', data.shape)
    else:
        data = np.load(Path(config[datasource_name]['embedding']))
        np_df = load_csv(datasource_name, numpy=True)
        phenotypes_dict = {val: idx for idx, val in enumerate(sorted(datasource.phenotype.unique()))}
        phenotypes_array = np_df[:, get_column_indices(['phenotype'])]
        for i in range(phenotypes_array.shape[0]):
            phenotypes_array[i, 0] = phenotypes_dict[phenotypes_array[i, 0]]
        phenotypes_array = np.array(phenotypes_array, dtype='uint16')
        data = np.hstack((data, phenotypes_array))

    data[:, 0:2] = normalize_scatterplot_data(data[:, 0:2])
    # normalized_data = MinMaxScaler(feature_range=(-1, 1)).fit_transform(data[:, :-1])
    # data[:, :2] = normalized_data
    list_of_obs = [[elem[0], elem[1], id, int(elem[3])] for id, elem in enumerate(data)]
    visData = {
        'data': list_of_obs,
        'clusters': np.unique(data[:, -1]).astype('int32').tolist()
    }
    print('Total Embedding Time', time.time() - this_time)
    return visData


def get_rect_cells(datasource_name, rect, channels):
    global datasource
    global source
    global ball_tree

    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)

    # Query
    index = ball_tree.query_radius([[rect[0], rect[1]]], r=rect[2])
    print('Query size:', len(index[0]))
    neighbors = index[0]
    try:
        neighborhood = []
        for neighbor in neighbors:
            row = datasource.iloc[[neighbor]]
            obj = row.to_dict(orient='records')[0]
            if 'phenotype' not in obj:
                obj['phenotype'] = ''
            neighborhood.append(obj)
        return neighborhood
    except:
        return {}


def get_cells_in_polygon(datasource_name, points, similar_neighborhood=False, embedding=False):
    global config
    global datasource
    import ome_types as ometypes
    fields = [config[datasource_name]['featureData'][0]['xCoordinate'],
              config[datasource_name]['featureData'][0]['yCoordinate'], 'phenotype', 'id']
    if embedding:
        start = time.process_time()
        point_tuples = [tuple(pt) for pt in MinMaxScaler(feature_range=(0, 1)).fit(
            [[-1], [1]]).transform(np.array(points)).tolist()]
        path = mpltPath.Path(point_tuples)
        embedding = np.load(Path(config[datasource_name]['embedding']))
        inside = path.contains_points(embedding[:, [0, 1]].astype('float'))
        print('Points in Embedding Polygon', time.process_time() - start)
        # neighbor_ids = datasource.loc[np.where(inside == True), 'id'].compute().tolist()
        neighbor_ids = datasource.loc[np.where(inside == True), 'id'].tolist()
    else:
        point_tuples = [(e['imagePoints']['x'], e['imagePoints']['y']) for e in points]
        (x, y, r) = smallestenclosingcircle.make_circle(point_tuples)

        circle_neighbors = get_individual_neighborhood(x, y, datasource_name, r=r,
                                                       fields=fields)
        neighbor_points = pd.DataFrame(circle_neighbors).values
        path = mpltPath.Path(point_tuples)
        inside = path.contains_points(neighbor_points[:, [0, 1]].astype('float'))
        neighbor_ids = neighbor_points[np.where(inside == True), 3].flatten()
    obj = get_neighborhood_stats(datasource_name, neighbor_ids, np_datasource, fields=fields)
    return obj


def get_similar_neighborhood_to_selection(datasource_name, selection_ids, similarity, mode='single'):
    global config
    fields = [config[datasource_name]['featureData'][0]['xCoordinate'],
              config[datasource_name]['featureData'][0]['yCoordinate'], 'phenotype', 'id']
    query_vector = None

    if mode == 'multi' and 'linkedDatasets' in config[datasource_name]:
        combined_selection = None
        for dataset in config[datasource_name]['linkedDatasets']:
            if dataset in selection_ids:
                neighborhoods = np.load(Path(config[dataset]['neighborhoods']))
                selected_rows = neighborhoods[selection_ids[dataset], :]
                if combined_selection is None:
                    combined_selection = selected_rows
                else:
                    combined_selection = np.vstack((combined_selection, selected_rows))
        query_vector = np.mean(combined_selection, axis=0)
    else:
        neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
        query_vector = np.mean(neighborhoods[selection_ids[datasource_name], :], axis=0)

    # We expect query in the form of a dict with a bit more info
    query_vector = query_vector.flatten()
    query_vector_dict = {}
    for i, phenotype in enumerate(sorted(datasource.phenotype.unique().tolist())):
        query_vector_dict[phenotype] = {'value': query_vector[i], 'key': phenotype}

    obj = find_custom_neighborhood(datasource_name, query_vector_dict, similarity, mode)
    return obj


def find_custom_neighborhood(datasource_name, neighborhood_composition, similarity, mode='single'):
    global datasource
    global source
    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)
    fields = [config[datasource_name]['featureData'][0]['xCoordinate'],
              config[datasource_name]['featureData'][0]['yCoordinate'], 'phenotype', 'id']
    # phenos = sorted(datasource.phenotype.unique().compute().tolist())
    phenos = sorted(datasource.phenotype.unique().tolist())
    neighborhood_vector = np.zeros((len(phenos)))
    disabled = []
    for i in range(len(phenos)):
        neighborhood_vector[i] = neighborhood_composition[phenos[i]]['value']
        if 'disabled' in neighborhood_composition[phenos[i]] and neighborhood_composition[phenos[i]]['disabled']:
            disabled.append(i)

    if mode == 'multi' and 'linkedDatasets' in config[datasource_name]:
        selection_ids = np.array([])
        obj = {}
        index_sum = 0
        query = None
        for dataset in config[datasource_name]['linkedDatasets']:
            np_df = load_csv(dataset, numpy=True)
            similar_ids, neighborhood_query = find_similarity(neighborhood_vector, similarity, dataset,
                                                              disabled)
            selection_ids = np.concatenate([selection_ids, similar_ids + index_sum])
            obj[dataset] = get_neighborhood_stats(dataset, similar_ids, np_df, fields=fields, compute_neighbors=False)
            query = neighborhood_query
            index_sum = index_sum + len(np_df)
        obj['composition_summary'] = weight_multi_image_neighborhood(obj, datasource_name, len(selection_ids))
        obj['composition_summary']['selection_neighborhoods'] = obj['composition_summary']['selection_neighborhoods'][
                                                                np.random.choice(obj['composition_summary'][
                                                                                     'selection_neighborhoods'].shape[
                                                                                     0], 10000, replace=True), :]
        # Deleting redundant data
        for dataset in config[datasource_name]['linkedDatasets']:
            if 'dataset' in obj:
                del obj[dataset]['composition_summary']['selection_neighborhoods']
                del obj[dataset]['composition_summary']['selection_ids']
        obj['selection_ids'] = selection_ids.tolist()

    else:
        similar_ids, neighborhood_query = find_similarity(neighborhood_vector, similarity, datasource_name, disabled)
        obj = get_neighborhood_stats(datasource_name, similar_ids, np_datasource, fields=fields)
        query = neighborhood_query
    obj['neighborhood_query'] = query
    return obj


def find_similarity(composition_summary, similarity, datasource_name, disabled=None):
    global config
    neighborhood_query = {'query_vector': composition_summary, 'disabled': disabled, 'threshold': similarity}
    neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
    greater_than = similarity_search(neighborhoods, neighborhood_query)
    return greater_than, neighborhood_query


def similarity_search(neighborhoods, neighborhood_query):
    disabled = neighborhood_query['disabled']
    query_vector = neighborhood_query['query_vector']
    threshold = neighborhood_query['threshold']
    if disabled:
        neighborhoods = np.delete(neighborhoods, disabled, axis=1)
        composition_summary = np.delete(query_vector, disabled, axis=0)
    # distances = 1 - spatial.distance.cdist([query_vector], neighborhoods, "cosine")[0]
    # distances = 1 - spatial.distance.cdist([query_vector], neighborhoods, "cosine")[0]
    scores = euclidian_distance_score(neighborhoods, np.array(query_vector))
    greater_than = np.argwhere(scores > threshold).flatten()
    return greater_than


#
def get_gated_cells(datasource_name, gates):
    global datasource
    global source
    global ball_tree

    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)

    query_string = ''
    for key, value in gates.items():
        if query_string != '':
            query_string += ' and '
        query_string += str(value[0]) + ' < ' + key + ' < ' + str(value[1])
    if query_string == None or query_string == "":
        return []
    query = datasource.query(query_string)[['id']].to_dict(orient='records')
    return query


def download_gating_csv(datasource_name, gates, channels):
    global datasource
    global source
    global ball_tree

    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)

    query_string = ''
    columns = []
    for key, value in gates.items():
        columns.append(key)
        if query_string != '':
            query_string += ' and '
        query_string += str(value[0]) + ' < ' + key + ' < ' + str(value[1])
    ids = datasource.query(query_string)[['id']].to_numpy().flatten()
    idField = get_cell_id_field(datasource_name)
    columns.append(idField)

    csv = datasource.copy()

    csv[idField] = datasource['id']
    for channel in channels:
        if channel in gates:
            csv.loc[csv[idField].isin(ids), key] = 1
            csv.loc[~csv[idField].isin(ids), key] = 0
        else:
            csv[channel] = 0

    return csv


def download_gates(datasource_name, gates, channels):
    global datasource
    global source
    global ball_tree

    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)
    arr = []
    for key, value in channels.items():
        arr.append([key, value[0], value[1]])
    csv = pd.DataFrame(arr)
    csv.columns = ['channel', 'gate_start', 'gate_end']
    csv['gate_active'] = False
    for channel in gates:
        csv.loc[csv['channel'] == channel, 'gate_active'] = True
        csv.loc[csv['channel'] == channel, 'gate_start'] = gates[channel][0]
        csv.loc[csv['channel'] == channel, 'gate_end'] = gates[channel][1]
    return csv


def get_datasource_description(datasource_name):
    global datasource
    global source
    global ball_tree

    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)
    description = datasource.describe().to_dict()
    for column in description:
        [hist, bin_edges] = np.histogram(datasource[column].to_numpy(), bins=50, density=True)
        midpoints = (bin_edges[1:] + bin_edges[:-1]) / 2
        description[column]['histogram'] = {}
        dat = []
        for i in range(len(hist)):
            obj = {}
            obj['x'] = midpoints[i]
            obj['y'] = hist[i]
            dat.append(obj)
        description[column]['histogram'] = dat
    return description


def generate_zarr_png(datasource_name, channel, level, tile):
    if config is None:
        load_datasource(datasource_name)
    global channels
    global seg
    [tx, ty] = tile.replace('.png', '').split('_')
    tx = int(tx)
    ty = int(ty)
    level = int(level)
    tile_width = config[datasource_name]['tileWidth']
    tile_height = config[datasource_name]['tileHeight']
    ix = tx * tile_width
    iy = ty * tile_height
    segmentation = False
    try:
        channel_num = int(re.match(r".*_(\d*)$", channel).groups()[0])
    except AttributeError:
        segmentation = True
    if segmentation:
        tile = seg[level][iy:iy + tile_height, ix:ix + tile_width]

        tile = tile.view('uint8').reshape(tile.shape + (-1,))[..., [0, 1, 2]]
        tile = np.append(tile, np.zeros((tile.shape[0], tile.shape[1], 1), dtype='uint8'), axis=2)
    else:
        if isinstance(channels, zarr.Array):
            tile = channels[channel_num, iy:iy + tile_height, ix:ix + tile_width]
        else:
            tile = channels[level][channel_num, iy:iy + tile_height, ix:ix + tile_width]
            tile = tile.astype('uint16')

    # tile = np.ascontiguousarray(tile, dtype='uint32')
    # png = tile.view('uint8').reshape(tile.shape + (-1,))[..., [2, 1, 0]]
    return tile


def get_pearsons_correlation(datasource_name):
    global datasource
    global source
    neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
    heatmap = np.zeros((neighborhoods.shape[1], neighborhoods.shape[1]))
    for i in range(0, neighborhoods.shape[1]):
        for j in range(0, i):
            p_cor = pearsonr(neighborhoods[:, i], neighborhoods[:, j])
            heatmap[i, j] = p_cor[0]
            heatmap[j, i] = p_cor[0]
    return heatmap


def get_spearmans_correlation(datasource_name, selection_ids):
    global datasource
    global ball_tree
    global source
    global config
    neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
    # Load if not loaded
    if datasource_name != source:
        load_datasource(datasource_name)
    test = time.time()
    if selection_ids is not None:
        neighborhoods = neighborhoods[sorted(selection_ids), :]
    coeffecients = pd.DataFrame(neighborhoods).corr('pearson').to_numpy()
    # coeffecients = pearsonr(neighborhoods)[0]
    coeffecients[np.isnan(coeffecients)] = 0
    heatmap = []
    for i in range(0, coeffecients.shape[0]):
        coeff_list = coeffecients[i, 0:i].tolist()
        coeff_list.append(None)
        heatmap.append(coeff_list)
    print('Spear Time', time.time() - test)
    return heatmap


def get_ome_metadata(datasource_name):
    global config
    timer = time.time()
    if config is None:
        load_datasource(datasource_name)

    try:
        metadata_file_name = datasource_name + "_metadata.pickle"
        metadata_path = Path(
            os.path.join(os.getcwd())) / "minerva_analysis" / "data" / "metadata" / metadata_file_name
        if metadata_path.is_file():
            image_metadata = pickle.load(open(metadata_path, "rb"))

        else:
            channel_io = tf.TiffFile(config[datasource_name]['channelFile'], is_ome=False)
            xml = channel_io.pages[0].tags['ImageDescription'].value
            image_metadata = from_xml(xml).images[0].pixels
            pickle.dump(image_metadata, open(metadata_path, 'wb'))
    except:
        image_metadata = {}
    print('Metadata Time', time.time() - timer)
    return image_metadata


def convertOmeTiff(filePath, channelFilePath=None, dataDirectory=None, isLabelImg=False):
    channel_info = {}
    channelNames = []
    if isLabelImg == False:
        channel_io = tf.TiffFile(str(filePath), is_ome=False)
        channels = zarr.open(channel_io.series[0].aszarr())
        if isinstance(channels, zarr.Array):
            channel_info['maxLevel'] = 1
            chunks = channels.chunks
            shape = channels.shape
        else:
            channel_info['maxLevel'] = len(channels)
            shape = channels[0].shape
            chunks = (1, 1024, 1024)
        chunks = (chunks[-2], chunks[-1])
        channel_info['tileHeight'] = chunks[0]
        channel_info['tileWidth'] = chunks[1]
        channel_info['height'] = shape[1]
        channel_info['width'] = shape[2]
        channel_info['num_channels'] = shape[0]
        for i in range(shape[0]):
            channelName = re.sub(r'\.ome|\.tiff|\.tif|\.png', '', filePath.name) + "_" + str(i)
            channelNames.append(channelName)
        channel_info['channel_names'] = channelNames
        return channel_info
    else:
        channel_io = tf.TiffFile(str(channelFilePath), is_ome=False)
        channels = zarr.open(channel_io.series[0].aszarr())
        directory = Path(dataDirectory + "/" + filePath.name)
        args = {}
        args['in_paths'] = [Path(filePath)]
        args['out_path'] = directory
        args['is_mask'] = True
        pyramid_assemble.main(py_args=args)

        return {'segmentation': str(directory)}


# @profile
def get_neighborhood_stats(datasource_name, indices, np_df, cluster_cells=None, fields=[], compute_neighbors=True):
    global ball_tree
    global source
    global config
    global metadata
    global datasource
    default_fields = ['id', 'Cluster', 'phenotype', config[datasource_name]['featureData'][0]['xCoordinate'],
                      config[datasource_name]['featureData'][0]['yCoordinate']]
    for field in fields:
        if field not in default_fields:
            default_fields.append(field)
    time_neighborhood_stats = time.time()
    if indices.dtype.kind != 'i':
        indices = indices.astype(int)
    if 'useCellID' in config[datasource_name]['featureData'][0]:
        default_fields.append('CellID')

    column_indices = get_column_indices(default_fields)

    if cluster_cells is None:
        cluster_cells = np_df[indices, :][:, column_indices]
    else:
        cluster_cells = cluster_cells[default_fields]
    neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
    row_sums = neighborhoods.sum(axis=1)
    neighborhoods = neighborhoods / row_sums[:, np.newaxis]
    selection_neighborhoods = neighborhoods[indices, :]
    print('Loading Neighborhood Time', time.time() - time_neighborhood_stats)

    if neighborhoods.shape[0] == selection_neighborhoods.shape[0]:
        sample_size = 10000
    else:
        # TODO: Replace sample_size = selection_neighborhoods.shape[0]
        sample_size = 10000

    composition_summary = np.mean(selection_neighborhoods, axis=0)
    if selection_neighborhoods.shape[0] > 0:
        selection_neighborhoods = selection_neighborhoods[
                                  np.random.choice(selection_neighborhoods.shape[0], sample_size, replace=True), :]
    # Sample down so we have 10k of full
    # if selection_neighborhoods.shape[0] > sample_size:
    #     selection_neighborhoods = selection_neighborhoods[
    #                               np.random.choice(selection_neighborhoods.shape[0], sample_size, replace=False), :]
    # else:
    #     selection_neighborhoods = selection_neighborhoods
    # scale_factor = int(sample_size / selection_neighborhoods.shape[0])
    #
    # selection_neighborhoods = np.tile(selection_neighborhoods, (scale_factor, 1))

    summary_stats = {'weighted_contribution': {}, 'selection_neighborhoods': selection_neighborhoods,
                     'selection_ids': indices}
    phenotypes = sorted(datasource.phenotype.unique().tolist())
    # phenotypes = sorted(df.phenotype.unique().tolist())
    # phenotypes = sorted(datasource.phenotype.unique().compute().tolist())
    summary_stats['weighted_contribution'] = list(map(list, zip(phenotypes, composition_summary)))

    obj = {
        # 'cells': cluster_cells.to_dict(orient='records'),
        'cells': fast_to_dict_records(cluster_cells, default_fields),
        'composition_summary': summary_stats,
        'phenotypes_list': phenotypes
    }
    print('Computing Stats Time', time.time() - time_neighborhood_stats)
    compute_neighbors = False;
    if compute_neighbors:

        points = cluster_cells[:, [3, 4]]
        # Hardcoded to 30 um
        if 'neighborhood_range' in config[datasource_name]:
            neighborhood_range = config[datasource_name]['neighborhood_range']
        else:
            neighborhood_range = 30  # default 30um
        r = neighborhood_range / metadata.physical_size_x
        neighbors = ball_tree.query_radius(points, r=r)
        unique_neighbors = np.unique(np.concatenate(neighbors).ravel())
        border_neighbors = np.setdiff1d(unique_neighbors, cluster_cells[:, 0].astype(int))
        neighbor_phenotypes = {}
        for elem in border_neighbors:
            neighbor_phenotypes[str(elem)] = np_df[elem, get_column_indices(['phenotype'])][0]
        obj['neighbors'] = unique_neighbors
        obj['neighbor_phenotypes'] = neighbor_phenotypes
    print('Neighbors Time', time.time() - time_neighborhood_stats)
    return obj


def get_contour_line_paths(datasource_name, selection_ids):
    global datasource
    global config
    idField = get_cell_id_field(datasource_name)
    cells = datasource.iloc[selection_ids]
    x = cells[config[datasource_name]['featureData'][0]['xCoordinate']].to_numpy()
    y = cells[config[datasource_name]['featureData'][0]['yCoordinate']].to_numpy()
    cell_points = np.column_stack((x, y))
    grid_points = 2 ** 7
    num_levels = 10
    kde = FFTKDE(kernel='gaussian')
    grid, points = kde.fit(cell_points).evaluate(grid_points)
    grid_x, grid_y = np.unique(grid[:, 0]), np.unique(grid[:, 1])
    z = points.reshape(grid_points, grid_points).T
    plt.ioff()
    cs = plt.contour(grid_x, grid_y, z, num_levels)
    levels = {}
    i = 0
    for collection in cs.collections:
        levels[str(i)] = []
        for path in collection.get_paths():
            levels[str(i)].append(path.vertices)
        i += 1
    return levels
    # return cell_points


import gzip


#
# @profile
@numba.jit(nopython=True, parallel=True)
def single_perm_test(_phenotypes_array, _len_phenos, _neighbors, _distances, _lengths):
    chunk = 50
    __phenotypes_array = _phenotypes_array.flatten()
    z = np.zeros((_phenotypes_array.shape[0], _len_phenos, chunk), dtype=np.float32)
    perm_matrix = np.zeros((_phenotypes_array.shape[0], _len_phenos), dtype=np.float32)
    for j in prange(chunk):
        ___phenotypes_array = np.random.permutation(__phenotypes_array)
        ___phenotypes_array = __phenotypes_array
        for i in prange(len(_lengths)):
            this_length = _lengths[i]
            dist = _distances[i, 0:this_length]
            rows = _neighbors[i, 0:this_length]
            phenos = ___phenotypes_array[rows].flatten()
            pheno_weight_indices = (phenos)
            result = np.zeros((_len_phenos), dtype=np.float32)
            for ind in prange(len(pheno_weight_indices)):
                result[pheno_weight_indices[ind]] += _distances[i][ind]
            # normalized = result
            # result = normalized.astype(np.float32)
            # norms[i] = np.linalg.norm(result)
            perm_matrix[i] = result / result.sum()
        # z[:, :, j] = perm_matrix / np.linalg.norm(perm_matrix, ord=1, axis=1)[:, np.newaxis]
        z[:, :, j] = perm_matrix

        # f = gzip.GzipFile('/Users/swarchol/Research/minerva_analysis/minerva_analysis/data/perm_test.npy.gz', "w")
        # np.save(file=f, arr=perm_matrix)
        # zarr.save('/Users/swarchol/Research/minerva_analysis/minerva_analysis/data/perm_test.zarr', perm_matrix)
        # cos = np.dot(perm_matrix, _vector.flatten()) / (norms * np.linalg.norm(_vector))
        # where = np.where(cos > _threshold)
        # results[j] = len(where[0])
    return z


# @numba.jit(nopython=True, parallel=True)
def test_with_saved_perm(_phenotypes_array, _perm_matrix, _vector, _lengths, _threshold=0.8):
    chunk = 1
    _vector = _vector.astype(np.float32)
    __phenotypes_array = _phenotypes_array.flatten()
    # LOAD
    perm_matrix = _perm_matrix

    norms = np.zeros((_phenotypes_array.shape[0],), dtype=np.float32)
    results = np.zeros(chunk, dtype=np.int32)
    for j in prange(chunk):
        scores = euclidian_distance_score(perm_matrix[:, :, j], _vector)
        # for i in prange(len(_lengths)):
        #     norms[i] = np.linalg.norm(perm_matrix[i, :, j])
        # cos = np.dot(perm_matrix[:, :, j], _vector.flatten()) / (norms * np.linalg.norm(_vector))
        where = np.where(scores > _threshold)
        results[j] = len(where[0])
    return results


@numba.jit(nopython=True, parallel=True)
def euclidian_distance_score(y1, y2):
    return 1.0 / ((np.sqrt(np.sum((y1 - y2) ** 2, axis=1))) + 1.0)


def p_val(val, perm_vals):
    return stats.ttest_1samp(perm_vals, val)[1]


# @profile
def get_multi_image_scatter_results(datasource_name, mode):
    results = {}
    if 'linkedDatasets' in config[datasource_name]:
        for dataset in config[datasource_name]['linkedDatasets']:
            if dataset != datasource_name or mode == 'multi' or mode == 'single':  # TODO:Remove
                np_df = load_csv(dataset, numpy=True)
                x_field = config[datasource_name]['featureData'][0]['xCoordinate']
                y_field = config[datasource_name]['featureData'][0]['yCoordinate']
                column_indices = get_column_indices([x_field, y_field, 'id'])
                data = np_df[:, column_indices].astype(int)
                # Get Cell Types
                phenotypes_dict = {val: idx for idx, val in enumerate(sorted(datasource.phenotype.unique()))}
                phenotypes_array = np_df[:, get_column_indices(['phenotype'])]
                for i in range(phenotypes_array.shape[0]):
                    phenotypes_array[i, 0] = phenotypes_dict[phenotypes_array[i, 0]]
                phenotypes_array = np.array(phenotypes_array, dtype='uint16')
                data = np.hstack((data, phenotypes_array))

                # data = df[[x_field, y_field, 'id']].to_numpy()
                normalized_data = normalize_scatterplot_data(data[:, 0:2])
                normalized_data[:, 1] = normalized_data[:, 1] * -1.0  # Flip image
                data = np.column_stack((normalized_data, data[:, 2:4]))
                results[dataset] = np.ascontiguousarray(data)

    return results


def get_column_indices(column_names):
    global datasource
    csv_column_names = list(datasource.columns)
    return [csv_column_names.index(column_name) for column_name in column_names]


def search_across_images(datasource_name, linked_datasource, neighborhood_query=None):
    results = {}
    if 'linkedDatasets' in config[datasource_name] and neighborhood_query is not None:
        for dataset in config[datasource_name]['linkedDatasets']:
            if dataset == linked_datasource:
                linked_neighborhoods = np.load(Path(config[dataset]['neighborhoods']))
                results[dataset] = {}
                results[dataset]['cells'] = similarity_search(linked_neighborhoods, neighborhood_query)
                num_results = len(results[dataset]['cells'])
                results[dataset]['num_results'] = num_results
                other_results = calc_p_value(dataset, linked_neighborhoods, neighborhood_query)
                results[dataset]['p_value'] = p_val(num_results, other_results)

                print('P Value', results[dataset]['p_value'])

    return results


@profile
def calc_p_value(datasource_name, linked_neighborhoods, neighborhood_query):
    global config
    global datasource

    vector = np.array(neighborhood_query['query_vector'], dtype='float32')

    matrix_file_name = datasource_name + "_matrix.pk"
    matrix_paths = Path(
        os.path.join(os.getcwd())) / "minerva_analysis" / "data" / "perms" / matrix_file_name

    test = time.time()
    if matrix_paths.is_file():
        perm_data = pickle.load(open(matrix_paths, "rb"))
    else:
        perm_data = get_perm_data(datasource_name, matrix_paths)
    print('P Load Data,', time.time() - test)
    test = time.time()

    zarr_file_name = datasource_name + "_perm.zarr"
    zarr_path = Path(
        os.path.join(os.getcwd())) / "minerva_analysis" / "data" / "perms" / zarr_file_name

    if zarr_path.is_dir():
        results = test_with_saved_perm(perm_data['phenotypes_array'], zarr.load(zarr_path), vector,
                                       perm_data['lengths'],
                                       neighborhood_query['threshold'])
    else:
        print('P Done Load Data,', time.time() - test)
        test = time.time()
        perms = single_perm_test(perm_data['phenotypes_array'], perm_data['len_phenos'], perm_data['neighbors'],
                                 perm_data['distances'], perm_data['lengths'])
        print('P Create Perm Matrix,', time.time() - test)
        test = time.time()
        zarr_perms = zarr.array(perms, chunks=(10000, perms.shape[1], None), compressor=Blosc(cname='zstd', clevel=3))
        zarr.save_array(zarr_path, zarr_perms)
        results = test_with_saved_perm(perm_data['phenotypes_array'], perms, vector,
                                       perm_data['lengths'],
                                       neighborhood_query['threshold'])
        print('P Calc Results,', time.time() - test)
        test = time.time()

    print('P Compute Perms,', time.time() - test)

    return results


def get_perm_data(datasource_name, matrix_paths):
    test = time.time()
    column_indices = get_column_indices([config[datasource_name]['featureData'][0]['xCoordinate'],
                                         config[datasource_name]['featureData'][0]['yCoordinate']])
    np_df = load_csv(datasource_name, numpy=True)
    print('P Done Data Loading,', time.time() - test)
    test = time.time()
    points = np_df[:, column_indices].astype(int)
    image_ball_tree = BallTree(points, metric='euclidean')
    print('P Ball Tree,', time.time() - test)
    test = time.time()
    image_metadata = get_ome_metadata(datasource_name)
    print('P Metadata,', time.time() - test)
    test = time.time()
    neighborhood_range = 50  # Default 30 microns
    r = neighborhood_range / image_metadata.physical_size_x
    neighbors, distances = image_ball_tree.query_radius(points, r=r, return_distance=True)
    print('P Query,', time.time() - test)
    test = time.time()

    max_neighbors = 0
    lengths = np.zeros((len(neighbors),))
    for i in range(len(neighbors)):
        lengths[i] = len(neighbors[i])
        if max_neighbors < len(neighbors[i]):
            max_neighbors = len(neighbors[i])
    neighbors_matrix = np.zeros((len(neighbors), max_neighbors))
    distances_matrix = np.zeros((len(neighbors), max_neighbors))

    for i in range(len(neighbors)):
        neighbors_matrix[i, 0:len(neighbors[i])] = neighbors[i]
        distances_matrix[i, 0:len(distances[i])] = 1 - (distances[i] / r)

    lengths = lengths.astype('uint16')
    neighbors_matrix = neighbors_matrix.astype('uint32')
    distances_matrix = distances_matrix.astype('float32')

    print('P Building Matrices,', time.time() - test)
    phenotypes_dict = {val: idx for idx, val in enumerate(sorted(datasource.phenotype.unique()))}
    phenotypes_array = np_df[:, get_column_indices(['phenotype'])]
    for i in range(phenotypes_array.shape[0]):
        phenotypes_array[i, 0] = phenotypes_dict[phenotypes_array[i, 0]]
    phenotypes_array = np.array(phenotypes_array, dtype='uint16').flatten()
    len_phenos = np.array([len(phenotypes_dict)], dtype='uint16')[0]
    perm_data = {'lengths': lengths, 'neighbors': neighbors_matrix, 'distances': distances_matrix,
                 'phenotypes_array': phenotypes_array, 'len_phenos': len_phenos}
    pickle.dump(perm_data, open(matrix_paths, 'wb'))
    return perm_data


def normalize_scatterplot_data(data):
    shifted_data = data - data.min()
    scaled_data = shifted_data / shifted_data.max()
    scaled_data = scaled_data * 2
    # Puts everything between -1 and 1
    scaled_data = scaled_data - 1
    return scaled_data


def get_cell_id_field(datasource_name):
    if 'idField' in config[datasource_name]['featureData'][0]:
        return config[datasource_name]['featureData'][0]['idField']
    else:
        return "CellID"


def apply_neighborhood_query(datasource_name, neighborhood_query):
    global config
    neighborhoods = np.load(Path(config[datasource_name]['neighborhoods']))
    similar_ids = similarity_search(neighborhoods, neighborhood_query)
    obj = get_neighborhood_stats(datasource_name, similar_ids, np_datasource)
    return obj


def calculate_axis_order(datasource_name):
    global datasource
    global config
    correlation_matrix = np.absolute(get_pearsons_correlation(datasource_name))
    phenotypes = get_phenotypes(datasource_name)
    order = [None for e in range(len(phenotypes))]
    starting_index = math.ceil(len(phenotypes) / 2.0)
    above_index = starting_index - 2
    below_index = starting_index
    below = True
    for i in range(starting_index):
        # Final Iter
        if i == starting_index - 1:
            remaining_phenotypes = list(filter(lambda x: x is not None, phenotypes))
            order[len(phenotypes) - 1] = remaining_phenotypes[0]
            if len(phenotypes) % 2 == 0:
                order[0] = remaining_phenotypes[1]
        else:
            top_corrs = np.argwhere(correlation_matrix.max() == correlation_matrix)[0]
            pair_one = top_corrs[0]
            pair_two = top_corrs[1]
            if below:
                order[below_index] = phenotypes[pair_one]
                order[below_index - 1] = phenotypes[pair_two]
                below_index += 2
            else:
                order[above_index] = phenotypes[pair_one]
                order[above_index - 1] = phenotypes[pair_two]
                above_index -= 2
            correlation_matrix[:, pair_one] = -1
            correlation_matrix[:, pair_two] = -1
            correlation_matrix[pair_one, :] = -1
            correlation_matrix[pair_two, :] = -1
            phenotypes[pair_one] = None
            phenotypes[pair_two] = None
            below = not below
    return order



# Via https://stackoverflow.com/questions/67050899/why-pandas-dataframe-to-dictrecords-performance-is-bad-compared-to-another-n
def fast_to_dict_records(np_df, columns=None):
    global datasource
    # data = df.values.tolist()
    data = np_df.tolist()
    return [
        dict(zip(columns, datum))
        for datum in data
    ]
