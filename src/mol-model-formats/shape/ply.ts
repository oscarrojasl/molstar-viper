/**
 * Copyright (c) 2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Schäfer, Marco <marco.schaefer@uni-tuebingen.de>
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { RuntimeContext, Task } from 'mol-task';
import { ShapeProvider } from 'mol-model/shape/provider';
import { Color } from 'mol-util/color';
import { PlyFile, PlyTable, PlyList } from 'mol-io/reader/ply/schema';
import { MeshBuilder } from 'mol-geo/geometry/mesh/mesh-builder';
import { Mesh } from 'mol-geo/geometry/mesh/mesh';
import { Shape } from 'mol-model/shape';
import { ChunkedArray } from 'mol-data/util';
import { arrayMax, fillSerial } from 'mol-util/array';
import { Column } from 'mol-data/db';
import { ParamDefinition as PD } from 'mol-util/param-definition';
import { ColorNames } from 'mol-util/color/tables';
import { deepClone } from 'mol-util/object';

// TODO support 'edge' and 'material' elements, see https://www.mathworks.com/help/vision/ug/the-ply-format.html

function createPlyShapeParams(vertex?: PlyTable) {
    const options: [string, string][] = [['', '']]
    const defaultValues = { group: '', red: '', green: '', blue: '' }
    if (vertex) {
        for (let i = 0, il = vertex.propertyNames.length; i < il; ++i) {
            const name = vertex.propertyNames[i]
            options.push([ name, name ])
        }

        // TODO hardcoded as convenience for data provided by MegaMol
        if (vertex.propertyNames.includes('atomid')) defaultValues.group = 'atomid'

        if (vertex.propertyNames.includes('red')) defaultValues.red = 'red'
        if (vertex.propertyNames.includes('green')) defaultValues.green = 'green'
        if (vertex.propertyNames.includes('blue')) defaultValues.blue = 'blue'
    }

    return {
        ...Mesh.Params,

        coloring: PD.MappedStatic(defaultValues.red && defaultValues.green && defaultValues.blue ? 'vertex' : 'uniform', {
            vertex: PD.Group({
                red: PD.Select(defaultValues.red, options, { label: 'Red Property' }),
                green: PD.Select(defaultValues.green, options, { label: 'Green Property' }),
                blue: PD.Select(defaultValues.blue, options, { label: 'Blue Property' }),
            }, { isFlat: true }),
            uniform: PD.Group({
                color: PD.Color(ColorNames.grey)
            }, { isFlat: true })
        }),
        grouping: PD.MappedStatic(defaultValues.group ? 'vertex' : 'none', {
            vertex: PD.Group({
                group: PD.Select(defaultValues.group, options, { label: 'Group Property' }),
            }, { isFlat: true }),
            none: PD.Group({ })
        }),
    }
}

export const PlyShapeParams = createPlyShapeParams()
export type PlyShapeParams = typeof PlyShapeParams

async function getMesh(ctx: RuntimeContext, vertex: PlyTable, face: PlyList, groupIds: ArrayLike<number>, mesh?: Mesh) {
    const builderState = MeshBuilder.createState(vertex.rowCount, vertex.rowCount / 4, mesh)
    const { vertices, normals, indices, groups } = builderState

    const x = vertex.getProperty('x')
    const y = vertex.getProperty('y')
    const z = vertex.getProperty('z')
    if (!x || !y || !z) throw new Error('missing coordinate properties')

    const nx = vertex.getProperty('nx')
    const ny = vertex.getProperty('ny')
    const nz = vertex.getProperty('nz')

    const hasNormals = !!nx && !!ny && !!nz

    for (let i = 0, il = vertex.rowCount; i < il; ++i) {
        if (i % 100000 === 0 && ctx.shouldUpdate) await ctx.update({ current: i, max: il, message: `adding vertex ${i}` })

        ChunkedArray.add3(vertices, x.value(i), y.value(i), z.value(i))
        if (hasNormals) ChunkedArray.add3(normals, nx!.value(i), ny!.value(i), nz!.value(i));
        ChunkedArray.add(groups, groupIds[i])
    }

    for (let i = 0, il = face.rowCount; i < il; ++i) {
        if (i % 100000 === 0 && ctx.shouldUpdate) await ctx.update({ current: i, max: il, message: `adding face ${i}` })

        const { entries, count } = face.value(i)
        if (count === 3) {
            ChunkedArray.add3(indices, entries[0], entries[1], entries[2])
        }
        // TODO support quadriliterals
    }

    const m = MeshBuilder.getMesh(builderState);
    m.normalsComputed = hasNormals
    await Mesh.computeNormals(m).runInContext(ctx)

    return m
}

const int = Column.Schema.int

type Grouping = { ids: ArrayLike<number>, map: ArrayLike<number> }
function getGrouping(vertex: PlyTable, props: PD.Values<PlyShapeParams>): Grouping {
    const { grouping } = props
    const { rowCount } = vertex
    const column = grouping.name === 'vertex' ? vertex.getProperty(grouping.params.group) : undefined

    const ids = column ? column.toArray({ array: Uint32Array }) : fillSerial(new Uint32Array(rowCount))
    const maxId = arrayMax(ids) // assumes uint ids
    const map = new Uint32Array(maxId + 1)
    for (let i = 0, il = ids.length; i < il; ++i) map[ids[i]] = i
    return { ids, map }
}

type Coloring = { red: Column<number>, green: Column<number>, blue: Column<number> }
function getColoring(vertex: PlyTable, props: PD.Values<PlyShapeParams>): Coloring {
    const { coloring } = props
    const { rowCount } = vertex

    let red: Column<number>, green: Column<number>, blue: Column<number>
    if (coloring.name === 'vertex') {
        red = vertex.getProperty(coloring.params.red) || Column.ofConst(127, rowCount, int)
        green = vertex.getProperty(coloring.params.green) || Column.ofConst(127, rowCount, int)
        blue = vertex.getProperty(coloring.params.blue) || Column.ofConst(127, rowCount, int)
    } else {
        const [r, g, b] = Color.toRgb(coloring.params.color)
        red = Column.ofConst(r, rowCount, int)
        green = Column.ofConst(g, rowCount, int)
        blue = Column.ofConst(b, rowCount, int)
    }

    return { red, green, blue }
}

function createShape(plyFile: PlyFile, mesh: Mesh, coloring: Coloring, grouping: Grouping) {
    const { red, green, blue } = coloring
    const { ids, map } = grouping
    return Shape.create(
        'ply-mesh', plyFile, mesh,
        (groupId: number) => {
            const idx = map[groupId]
            return Color.fromRgb(red.value(idx), green.value(idx), blue.value(idx))
        },
        () => 1, // size: constant
        (groupId: number) => {
            return ids[groupId].toString()
        }
    )
}

function makeShapeGetter() {
    let _plyFile: PlyFile | undefined
    let _props: PD.Values<PlyShapeParams> | undefined

    let _shape: Shape<Mesh>
    let _mesh: Mesh
    let _coloring: Coloring
    let _grouping: Grouping

    const getShape = async (ctx: RuntimeContext, plyFile: PlyFile, props: PD.Values<PlyShapeParams>, shape?: Shape<Mesh>) => {

        const vertex = plyFile.getElement('vertex') as PlyTable
        if (!vertex) throw new Error('missing vertex element')

        const face = plyFile.getElement('face') as PlyList
        if (!face) throw new Error('missing face element')

        let newMesh = false
        let newColor = false

        if (!_plyFile || _plyFile !== plyFile) {
            newMesh = true
        }

        if (!_props || !PD.isParamEqual(PlyShapeParams.grouping, _props.grouping, props.grouping)) {
            newMesh = true
        }

        if (!_props || !PD.isParamEqual(PlyShapeParams.coloring, _props.coloring, props.coloring)) {
            newColor = true
        }

        if (newMesh) {
            _coloring = getColoring(vertex, props)
            _grouping = getGrouping(vertex, props)
            _mesh = await getMesh(ctx, vertex, face, _grouping.ids, shape && shape.geometry)
            _shape = createShape(plyFile, _mesh, _coloring, _grouping)
        } else if (newColor) {
            _coloring = getColoring(vertex, props)
            _shape = createShape(plyFile, _mesh, _coloring, _grouping)
        }

        _plyFile = plyFile
        _props = deepClone(props)

        return _shape
    }
    return getShape
}

export function shapeFromPly(source: PlyFile, params?: {}) {
    return Task.create<ShapeProvider<PlyFile, Mesh, PlyShapeParams>>('Shape Provider', async ctx => {
        return {
            label: 'Mesh',
            data: source,
            params: createPlyShapeParams(source.getElement('vertex') as PlyTable),
            getShape: makeShapeGetter(),
            geometryUtils: Mesh.Utils
        }
    })
}