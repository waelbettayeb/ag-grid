import {
    Column,
    ExcelFactoryMode,
    ExcelHeaderFooterConfig,
    ExcelImage,
    ExcelRelationship,
    ExcelSheetMargin,
    ExcelSheetPageSetup,
    ExcelStyle,
    ExcelWorksheet,
    RowHeightCallbackParams,
    XmlElement,
    _
} from '@ag-grid-community/core';

import coreFactory from './files/ooxml/core';
import contentTypesFactory from './files/ooxml/contentTypes';
import drawingFactory from './files/ooxml/drawing';
import officeThemeFactory from './files/ooxml/themes/office';
import sharedStringsFactory from './files/ooxml/sharedStrings';
import stylesheetFactory, { registerStyles } from './files/ooxml/styles/stylesheet';
import workbookFactory from './files/ooxml/workbook';
import worksheetFactory from './files/ooxml/worksheet';
import relationshipsFactory from './files/ooxml/relationships';

import { XmlFactory } from "@ag-grid-community/csv-export";

type ImageIdMap = Map</** imageId */string, { type: string, index: number }>;

/**
 * See https://www.ecma-international.org/news/TC45_current_work/OpenXML%20White%20Paper.pdf
 */
export class ExcelXlsxFactory {

    private static sharedStrings: Map<string, number> = new Map();
    private static sheetNames: string[] = [];

    /** Maps images to sheet */
    public static images: Map<string, { sheetId: number, image: ExcelImage[] }[]> = new Map();
    /** Maps sheets to images */
    public static worksheetImages: Map<number, ExcelImage[]> = new Map();
    /** Maps all workbook images to a global Id */
    public static workbookImageIds: ImageIdMap = new Map();
    /** Maps all sheet images to unique Ids */
    public static worksheetImageIds: Map<number, ImageIdMap> = new Map();

    public static factoryMode: ExcelFactoryMode = ExcelFactoryMode.SINGLE_SHEET;

    public static createExcel(
        styles: ExcelStyle[],
        worksheet: ExcelWorksheet,
        margins?: ExcelSheetMargin,
        pageSetup?: ExcelSheetPageSetup,
        headerFooterConfig?: ExcelHeaderFooterConfig
    ): string {
        this.addSheetName(worksheet);
        registerStyles(styles);

        return this.createWorksheet(worksheet, margins, pageSetup, headerFooterConfig);
    }

    public static getHeightFromProperty(rowIndex: number, height?: number | ((params: RowHeightCallbackParams) => number)): number | undefined {
        if (!height) { return; }

        let finalHeight: number;

        if (typeof height === 'number') {
            finalHeight = height;
        } else {
            const heightFunc = height as Function;
            finalHeight = heightFunc({ rowIndex });
        }

        // divide the height by 1.3333 because the height is provided in pixels, but Excel only accepts `pt`.
        return Math.round(finalHeight / 1.3333);
    }

    private static setExcelImageTotalWidth(image: ExcelImage, columnsToExport: Column[]): void {
        const { colSpan, column } = image.position!;

        if (image.width) {
            if (colSpan) {
                const columnsInSpan = columnsToExport.slice(column! - 1, column! + colSpan - 1);
                let totalWidth = 0;
                for (let i = 0; i < columnsInSpan.length; i++) {
                    const colWidth = columnsInSpan[i].getActualWidth();
                    if (image.width < totalWidth + colWidth) {
                        image.position!.colSpan = i + 1;
                        image.totalWidth = image.width;
                        image.width = image.totalWidth - totalWidth;
                        break;
                    }
                    totalWidth += colWidth;
                }
            } else { 
                image.totalWidth = image.width;
            }
        }
    }

    private static setExcelImageTotalHeight(image: ExcelImage, rowHeight?: number | ((params: RowHeightCallbackParams) => number)): void {
        const { rowSpan, row } = image.position!;

        if (image.height) {
            if (rowSpan) {
                let totalHeight = 0;
                let counter = 0;
                for (let i = row!; i < row! + rowSpan; i++) {
                    // we need to multiply by 1.33333 because getHeightFromProperty returns the rowHeight in `pt`.
                    const nextRowHeight = Math.floor((ExcelXlsxFactory.getHeightFromProperty(i, rowHeight) || 20) * 1.33333);
                    if (image.height < totalHeight + nextRowHeight) {
                        image.position!.rowSpan = counter + 1;
                        image.totalHeight = image.height;
                        image.height = image.totalHeight - totalHeight;
                        break;
                    }
                    totalHeight += nextRowHeight;
                    counter++;
                }
            } else {
                image.totalHeight = image.height;
            }
        }

    }

    public static buildImageMap(image: ExcelImage, rowIndex: number, col: Column, columnsToExport: Column[], rowHeight?: number | ((params: RowHeightCallbackParams) => number)): void {
        const currentSheetIndex = this.sheetNames.length;
        const registeredImage = this.images.get(image.id);

        if (!image.position || !image.position.row || !image.position.column) {
            if (!image.position) { image.position = {}; }

            image.position = _.assign({}, image.position, {
                row: rowIndex,
                column: columnsToExport.indexOf(col) + 1
            });
        }

        this.setExcelImageTotalWidth(image, columnsToExport);
        this.setExcelImageTotalHeight(image, rowHeight);

        if (registeredImage) {
            const currentSheetImages = _.find(registeredImage, (currentImage) => currentImage.sheetId === currentSheetIndex);
            if (currentSheetImages) {
                currentSheetImages.image.push(image);
            } else {
                registeredImage.push({
                    sheetId: currentSheetIndex,
                    image: [image]
                });
            }
        } else {
            this.images.set(image.id, [{ sheetId: currentSheetIndex, image: [image] }])
            this.workbookImageIds.set(image.id, { type: image.imageType, index: this.workbookImageIds.size });
        }

        this.buildSheetImageMap(currentSheetIndex, image);
    }

    private static buildSheetImageMap(sheetIndex: number, image: ExcelImage): void {
        let worksheetImageIdMap = this.worksheetImageIds.get(sheetIndex);

        if (!worksheetImageIdMap) {
            worksheetImageIdMap = new Map();
            this.worksheetImageIds.set(sheetIndex, worksheetImageIdMap);
        }

        const sheetImages = this.worksheetImages.get(sheetIndex);

        if (!sheetImages) {
            this.worksheetImages.set(sheetIndex, [image]);
            worksheetImageIdMap.set(image.id, { index: 0, type: image.imageType });
        } else {
            sheetImages.push(image);
            if (!worksheetImageIdMap.get(image.id)) {
                worksheetImageIdMap.set(image.id, { index: worksheetImageIdMap.size, type: image.imageType });
            }
        }
    }

    private static addSheetName(worksheet: ExcelWorksheet): void {
        const name = worksheet.name;
        let append = '';

        while (this.sheetNames.indexOf(name + append) !== -1) {
            if (append === '') {
                append = '_1'
            } else {
                const curr = parseInt(append.slice(1), 10);
                append = `_${curr + 1}`;
            }
        }

        worksheet.name += append;
        this.sheetNames.push(worksheet.name);
    }

    public static getStringPosition(str: string): number {
        if (this.sharedStrings.has(str)) {
            return this.sharedStrings.get(str)!;
        }

        this.sharedStrings.set(str, this.sharedStrings.size);
        return this.sharedStrings.size - 1;
    }

    public static resetFactory(): void {
        this.sharedStrings = new Map();

        this.images = new Map();
        this.worksheetImages = new Map();

        this.workbookImageIds = new Map();
        this.worksheetImageIds = new Map();

        this.sheetNames = [];
        this.factoryMode = ExcelFactoryMode.SINGLE_SHEET;
    }

    public static createWorkbook(): string {
        return this.createXmlPart(workbookFactory.getTemplate(this.sheetNames));
    }

    public static createStylesheet(defaultFontSize: number): string {
        return this.createXmlPart(stylesheetFactory.getTemplate(defaultFontSize));
    }

    public static createSharedStrings(): string {
        return this.createXmlPart(sharedStringsFactory.getTemplate(this.sharedStrings));
    }

    public static createCore(author: string): string {
        return this.createXmlPart(coreFactory.getTemplate(author));
    }

    public static createContentTypes(sheetLen: number): string {
        return this.createXmlPart(contentTypesFactory.getTemplate(sheetLen));
    }

    public static createRels(): string {
        const rs = relationshipsFactory.getTemplate([{
            Id: 'rId1',
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
            Target: 'xl/workbook.xml'
        }, {
            Id: 'rId2',
            Type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
            Target: 'docProps/core.xml'
        }]);

        return this.createXmlPart(rs);
    }

    public static createTheme(): string {
        return this.createXmlPart(officeThemeFactory.getTemplate());
    }

    public static createWorkbookRels(sheetLen: number): string {
        const worksheets = _.fill(new Array(sheetLen), undefined).map((v, i) => ({
            Id: `rId${i + 1}`,
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
            Target: `worksheets/sheet${i + 1}.xml`
        }));

        const rs = relationshipsFactory.getTemplate([
            ...worksheets,
        {
            Id: `rId${sheetLen + 1}`,
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
            Target: 'theme/theme1.xml'
        }, {
            Id: `rId${sheetLen + 2}`,
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
            Target: 'styles.xml'
        }, {
            Id: `rId${sheetLen + 3}`,
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
            Target: 'sharedStrings.xml'
        }]);

        return this.createXmlPart(rs);
    }

    public static createDrawing(sheetIndex: number) {
        return this.createXmlPart(drawingFactory.getTemplate({ sheetIndex }));
    }

    public static createDrawingRel(sheetIndex: number) {
        const worksheetImageIds = this.worksheetImageIds.get(sheetIndex);
        const XMLArr: ExcelRelationship[] = [];

        worksheetImageIds!.forEach((value, key) => {
            XMLArr.push({
                Id: `rId${value.index + 1}`,
                Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
                Target: `../media/image${this.workbookImageIds.get(key)!.index + 1}.${value.type}`
            })
        });

        return this.createXmlPart(relationshipsFactory.getTemplate(XMLArr));
    }

    public static createWorksheetDrawingRel(currentRelationIndex: number) {
        const rs = relationshipsFactory.getTemplate([{
            Id: 'rId1',
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
            Target: `../drawings/drawing${currentRelationIndex + 1}.xml`
        }]);

        return this.createXmlPart(rs);
    }

    private static createXmlPart(body: XmlElement): string {
        const header = XmlFactory.createHeader({
            encoding: 'UTF-8',
            standalone: 'yes'
        });

        const xmlBody = XmlFactory.createXml(body);
        return `${header}${xmlBody}`;
    }

    private static createWorksheet(
        worksheet: ExcelWorksheet,
        margins?: ExcelSheetMargin,
        pageSetup?: ExcelSheetPageSetup,
        headerFooterConfig?: ExcelHeaderFooterConfig,
    ): string {
        return this.createXmlPart(worksheetFactory.getTemplate({
            worksheet,
            currentSheet: this.sheetNames.length - 1,
            margins,
            pageSetup,
            headerFooterConfig
        }));
    }
}
