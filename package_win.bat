pyinstaller -F --paths $env:CONDA_PREFIX --add-data "minerva_analysis/client;minerva_analysis/client" --add-data "minerva_analysis/server;minerva_analysis/server" --add-data "%CONDA_PREFIX%/Lib/site-packages/xmlschema/schemas;xmlschema/schemas" --add-data "%CONDA_PREFIX%/Lib/site-packages/ome_types;ome_types" --hidden-import "scipy.spatial.transform._rotation_groups" --hidden-import cmath --hidden-import llvmlite --hidden-import="sqlalchemy.sql.default_comparator" --hidden-import="sklearn.utils._typedefs" --hidden-import="sklearn.neighbors._partition_nodes" --collect-all numba --collect-all llvmlite --clean --onefile --icon icon.ico  --name minerva_analysis_windows run.py