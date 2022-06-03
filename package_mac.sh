pyinstaller -F --paths $CONDA_PREFIX --add-data "minerva_analysis/client:minerva_analysis/client" --add-data "minerva_analysis/__init__.py:minerva_analysis/" --add-data "minerva_analysis/server:minerva_analysis/server" --add-data "$CONDA_PREFIX/lib/python3.8/site-packages/xmlschema/schemas:xmlschema/schemas" --hidden-import "scipy.spatial.transform._rotation_groups" --hidden-import "sklearn.utils._vector_sentinel" --hidden-import "sklearn.utils._sorting" --hidden-import "sqlalchemy.sql.default_comparator" --hidden-import "sklearn.utils._heap" --hidden-import "sklearn.utils._typedefs" --hidden-import "sklearn.neighbors._partition_nodes" --hidden-import cmath  --name minerva_analysis_mac run.py
