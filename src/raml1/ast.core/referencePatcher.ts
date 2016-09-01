/// <reference path="../../../typings/main.d.ts" />
import ll=require("../lowLevelAST");
import hl=require("../highLevelAST");
import hlimpl=require("../highLevelImpl");
import yaml=require("yaml-ast-parser");
import jsyaml=require("../jsyaml/jsyaml2lowLevel");
import util=require("../../util/index");
import proxy=require("./LowLevelASTProxy");
import universeDef=require("../tools/universe");
import _ = require("underscore");
import universeHelpers = require("../tools/universeHelpers");
import namespaceResolver = require("./namespaceResolver");
import def = require("raml-definition-system");
import typeExpressions = def.rt.typeExpressions;
import expander=require("./expander");

export enum PatchMode{
    DEFAULT, PATH
}

export class ReferencePatcher{
    
    constructor(protected mode:PatchMode = PatchMode.DEFAULT){}

    private _outerDependencies:{[key:string]:DependencyMap} = {};

    process(
        hlNode:hl.IHighLevelNode,
        rootNode:hl.IHighLevelNode=hlNode,
        removeUses:boolean=false,
        patchNodeName:boolean=false){
        var resolver = (<jsyaml.Project>hlNode.lowLevel().unit().project()).namespaceResolver();
        this.patchReferences(hlNode,rootNode,resolver);
        if(patchNodeName){
            this.patchNodeName(hlNode,rootNode.lowLevel().unit(),resolver);
        }
        if(removeUses){
            this.removeUses(hlNode.lowLevel());
        }
        else {
            this.patchUses(hlNode.lowLevel(), resolver);
        }
        this.resetTypes(hlNode);
        hlNode.resetChildren();
    }

    patchReferences(
        node:hl.IHighLevelNode,
        rootNode:hl.IHighLevelNode = node,
        resolver:namespaceResolver.NamespaceResolver=new namespaceResolver.NamespaceResolver(),
        units:ll.ICompilationUnit[] = [ rootNode.lowLevel().unit() ]){

        var isNode:proxy.LowLevelCompositeNode;
        if(node.definition().property(universeDef.Universe10.TypeDeclaration.properties.annotations.name)!=null){
            var cNode = <proxy.LowLevelCompositeNode>node.lowLevel();
            if(!(cNode instanceof proxy.LowLevelCompositeNode)){
                return;
            }
            var isPropertyName = universeDef.Universe10.MethodBase.properties.is.name;
            var traitNodes = node.attributes(isPropertyName);
            cNode.preserveAnnotations();
            node.resetChildren();
            if(traitNodes.length!=0) {                                
                isNode = patchMethodIs(node,traitNodes.map(x=>x.lowLevel()).map(x=>{
                    return{
                        node: x,
                        transformer: (<proxy.LowLevelProxyNode>x).transformer()
                    };
                }));
            }
        }

        var attrs = node.attrs();
        for(var attr of attrs){
            var appended = this.appendUnitIfNeeded(attr,units);
            this.patchReferenceAttr(attr,rootNode,resolver,units);
            this.popUnitIfNeeded(units,appended);
        }

        if(universeHelpers.isTypeDeclarationDescendant(node.definition())){
            var appended = this.appendUnitIfNeeded(node,units);
            this.patchType(node,rootNode,resolver,units);
            this.popUnitIfNeeded(units,appended);
        }
        
        var childNodes = node.elements();
        for( var ch of childNodes) {
            var appended = this.appendUnitIfNeeded(ch,units);
            this.patchReferences(ch,rootNode,resolver,units);
            this.popUnitIfNeeded(units,appended);
        }
        if(isNode){
            isNode.filterChildren();
        }
    }

    patchReferenceAttr(
        attr:hl.IAttribute,
        rootNode:hl.IHighLevelNode,
        resolver:namespaceResolver.NamespaceResolver,
        units:ll.ICompilationUnit[]){

        var property = attr.property();
        var range = property.range();
        if(!range.isAssignableFrom(universeDef.Universe10.Reference.name)){
            return;
        }
        var value = attr.value();
        if(value==null){
            return;
        }

        var llNode:proxy.LowLevelProxyNode = <proxy.LowLevelProxyNode>attr.lowLevel();
        if(!(llNode instanceof proxy.LowLevelProxyNode)){
            return;
        }
        var transformer:expander.DefaultTransformer = <expander.DefaultTransformer>llNode.transformer();
        
        var isAnnotation = universeHelpers.isAnnotationsProperty(property);
        if(typeof value == "string"){
            let stringToPatch = value;
            if(transformer!=null){
                var actualNode = toOriginal(llNode);
                stringToPatch = actualNode.value();
            }
            if(isAnnotation){
                stringToPatch = stringToPatch.substring(1,stringToPatch.length-1);
            }
            var newValue = this.resolveReferenceValue(
                stringToPatch,rootNode.lowLevel().unit(),units,resolver,transformer,range);
            if(newValue!=null){
                var newValue1 = isAnnotation ? `(${newValue.value()})` : newValue.value();
                (<proxy.LowLevelProxyNode>attr.lowLevel()).setValueOverride(newValue1);
                this.registerPatchedReference(newValue);
            }
        }
        else{
            var sValue = <hlimpl.StructuredValue>value;
            var key = sValue.lowLevel().key();
            let stringToPatch = key;
            if(transformer!=null){
                var actualNode = toOriginal(sValue.lowLevel());
                stringToPatch = actualNode.key();
            }
            if(key!=null){
                if(isAnnotation){
                    stringToPatch = stringToPatch.substring(1,stringToPatch.length-1);
                }
                var newValue = this.resolveReferenceValue(
                    stringToPatch,rootNode.lowLevel().unit(),units,resolver,transformer,range);
                if(newValue!=null) {
                    var newValue1 = isAnnotation ? `(${newValue.value()})` : newValue.value();
                    (<proxy.LowLevelProxyNode>sValue.lowLevel()).setKeyOverride(newValue1);
                    this.registerPatchedReference(newValue);
                }
            }
        }

    }

    patchType(
        node:hl.IHighLevelNode,
        rootNode:hl.IHighLevelNode,
        resolver:namespaceResolver.NamespaceResolver,
        units:ll.ICompilationUnit[]){

        var nodeType = node.definition()

        if(!node.localType().isExternal()) {

            var rootUnit = rootNode.lowLevel().unit();
            var rootPath = rootUnit.absolutePath();
            

            //if(rootPath != localPath) {
                var typeAttributes = node.attributes(universeDef.Universe10.TypeDeclaration.properties.type.name);
                for( var typeAttr of typeAttributes) {
                    var llNode:proxy.LowLevelProxyNode = <proxy.LowLevelProxyNode>typeAttr.lowLevel();
                    if(!(llNode instanceof proxy.LowLevelProxyNode)){
                        continue;
                    }
                    var localUnit = typeAttr.lowLevel().unit();
                    var localPath = localUnit.absolutePath();
                    if(localPath==rootPath && this.mode == PatchMode.DEFAULT){
                        continue;
                    }
                    var value = typeAttr.value();
                    if(typeof value == "string") {

                        var gotExpression = checkExpression(value);                        
                        var transformer:expander.DefaultTransformer = <expander.DefaultTransformer>llNode.transformer();
                        var stringToPatch = value;
                        var escapeData:EscapeData = { status: ParametersEscapingStatus.NOT_REQUIRED };
                        var additionalUnits = transformer ? transformer.unitsChain : null;
                        if(transformer!=null||value.indexOf("<<")>=0){                            
                            var actualNode = toOriginal(llNode);
                            var actualValue = actualNode.value();
                            escapeData = escapeTemplateParameters(actualValue);
                            if (escapeData.status == ParametersEscapingStatus.OK) {
                                if (gotExpression) {
                                    stringToPatch = escapeData.resultingString;
                                }
                                else {
                                    stringToPatch = actualValue;
                                }
                            }
                            else {
                                transformer = null;
                            }
                        }
                        var appendedAdditional:boolean[];
                        if(additionalUnits){
                            appendedAdditional = [];
                            for(var u of additionalUnits){
                                appendedAdditional.push(this.appendUnitIfNeeded(u,units));
                            }
                        }
                        var appendedAttrUnit = this.appendUnitIfNeeded(typeAttr,units);
                        
                        var newValue:string;
                        if(gotExpression){
                            var expressionPatchFailed = false;
                            var expr = typeExpressions.parse(stringToPatch);
                            var gotPatch = false;
                            typeExpressions.visit(expr, x=> {
                                if (x.type == "name") {
                                    var lit = <typeExpressions.Literal>x;
                                    var typeName = lit.value;
                                    var unescapeData:EscapeData = { status: ParametersEscapingStatus.NOT_REQUIRED };
                                    var unescaped:string;
                                    if(escapeData.status == ParametersEscapingStatus.OK){
                                        unescaped = escapeData.substitutions[typeName];
                                        if(unescaped==null){
                                            unescapeData = unescapeTemplateParameters(
                                                typeName,escapeData.substitutions);
                                            if(unescapeData.status==ParametersEscapingStatus.OK){
                                                typeName = unescapeData.resultingString;
                                            }
                                            else if(unescapeData.status==ParametersEscapingStatus.ERROR){
                                                expressionPatchFailed = true;
                                                return;
                                            }
                                        }
                                        else{
                                            typeName = unescaped;
                                        }
                                    }
                                    if(transformer==null && (unescaped!=null||unescapeData.status==ParametersEscapingStatus.OK)){
                                        lit.value = typeName;
                                        return;
                                    }
                                    var patched = this.resolveReferenceValue(
                                        typeName, rootUnit, units, resolver, transformer, nodeType);
                                    if (patched != null) {
                                        lit.value = patched.value();
                                        gotPatch = true;
                                        this.registerPatchedReference(patched);
                                    }
                                }
                            });
                            if(gotPatch&&!expressionPatchFailed) {
                                newValue = typeExpressions.serializeToString(expr);
                            }
                            else{
                                newValue = value;                                
                            }
                        }
                        else if(!(escapeData.status==ParametersEscapingStatus.OK && transformer==null)){
                            var patched = this.resolveReferenceValue(stringToPatch, rootUnit, units, resolver, transformer, nodeType);
                            if(patched!=null) {
                                this.registerPatchedReference(patched);
                                newValue = patched.value();
                            }
                        }
                        if (newValue != null) {
                            (<proxy.LowLevelProxyNode>typeAttr.lowLevel()).setValueOverride(newValue);
                            (<hlimpl.ASTPropImpl>typeAttr).overrideValue(null);
                        }
                        this.popUnitIfNeeded(units,appendedAttrUnit);
                        if(appendedAdditional){
                            for(var ap of appendedAdditional.reverse()){
                                this.popUnitIfNeeded(units,ap);
                            }
                        }
                    }
                    else{
                        var llTypeNode = _.find(node.lowLevel().children(),x=>x.key()=="type");
                        if(llTypeNode){
                            var def = node.definition().universe().type(universeDef.Universe10.TypeDeclaration.name);
                            var newNode = new hlimpl.ASTNodeImpl(llTypeNode,null,def,null);
                            var appended = this.appendUnitIfNeeded(newNode,units);
                            this.patchReferences(newNode,rootNode,resolver,units);
                            this.popUnitIfNeeded(units,appended);
                        }
                    }
                }
            // }
        }
    }

    private resolveReferenceValue(
        stringToPatch:string,
        rootUnit:ll.ICompilationUnit,
        units:ll.ICompilationUnit[],
        resolver:namespaceResolver.NamespaceResolver,
        transformer:expander.DefaultTransformer,
        range:def.ITypeDefinition):PatchedReference
    {
        var isAnnotation = universeHelpers.isAnnotationRefTypeOrDescendant(range);
        var newValue:PatchedReference;
        if (transformer) {
            if (stringToPatch && stringToPatch.indexOf("<<") >= 0) {
                var doContinue = true;
                var types = (<hlimpl.ASTNodeImpl>rootUnit.highLevel()).types();
                newValue = transformer.transform(stringToPatch, true, ()=>doContinue, (val, tr)=> {
                    var newVal = this.resolveReferenceValueBasic(val, rootUnit, resolver, tr.unitsChain, range);
                    if (newVal == null) {
                        newVal = new PatchedReference(null,val,this.collectionName(range),rootUnit,PatchMode.DEFAULT);
                    }
                    if(isAnnotation){
                        if (types.getAnnotationType(newVal.value()) != null) {
                            doContinue = false;
                        }
                        else if (this.mode==PatchMode.PATH){
                            doContinue = false;
                        }
                    }
                    else if (types.getType(newVal.value()) != null) {
                        doContinue = false;
                    }
                    else if (this.mode==PatchMode.PATH){
                        doContinue = false;
                    }
                    return newVal;
                }).value;
            }
        }
        if (newValue === undefined) {
            newValue = this.resolveReferenceValueBasic(stringToPatch, rootUnit, resolver, units, range);
        }
        return newValue;
    }

    patchNodeName(
        hlNode:hl.IHighLevelNode,
        rootUnit:ll.ICompilationUnit,
        resolver:namespaceResolver.NamespaceResolver){
        
        var llNode = <proxy.LowLevelProxyNode>hlNode.lowLevel();
        var key = llNode.key();
        var range  = hlNode.definition();        
        if(universeHelpers.isTypeDeclarationSibling(range)) {
            var localType = hlNode.localType();
            if(localType.isAnnotationType()){
                range = localType;
            }
        }
        
        var patched = this.resolveReferenceValueBasic(key,rootUnit,resolver,[llNode.unit()],range);
        if(patched != null){
            llNode.setKeyOverride(patched.value());
        }
    }

    resolveReferenceValueBasic(
        value:string,
        rootUnit:ll.ICompilationUnit,
        resolver:namespaceResolver.NamespaceResolver,
        units:ll.ICompilationUnit[],
        range:def.ITypeDefinition):PatchedReference{
        
        var isType = universeHelpers.isTypeDeclarationDescendant(range);

        var ind = value.lastIndexOf(".");

        var referencedUnit:ll.ICompilationUnit;
        var plainName:string;
        if (ind >= 0) {
            var oldNS = value.substring(0, ind);
            plainName = value.substring(ind + 1);

            for(var i = units.length ; i > 0 ; i--) {
                var localUnit = units[i-1];
                var nsMap = resolver.nsMap(localUnit);
                if(nsMap==null){
                    continue;
                }
                var info = nsMap[oldNS];
                if(info==null){
                    continue;
                }
                referencedUnit = info.unit;
                if(referencedUnit!=null){
                    break;
                }
            }
        }
        else {
            if(isType&&def.rt.builtInTypes().get(value)!=null){
                return null;
            }
            plainName = value;
            referencedUnit = units[units.length-1];
        }
        var collectionName = this.collectionName(range);
        if(this.mode == PatchMode.PATH){
            if(referencedUnit==null||referencedUnit.absolutePath()==rootUnit.absolutePath()){
                return null;
            }
            var aPath = referencedUnit.absolutePath().replace(/\\/g,"/");
            if(!ll.isWebPath(aPath)){
                aPath = "file:///" + aPath;
            }
            newNS = `${aPath}#/${collectionName}`;
        }
        else {
            var newNS = resolver.resolveNamespace(rootUnit, referencedUnit);
            if (newNS == null) {
                return null;
            }
        }
        return new PatchedReference(newNS,plainName,collectionName,referencedUnit,this.mode);
    }

    patchUses(node:ll.ILowLevelASTNode,resolver:namespaceResolver.NamespaceResolver){
        if(!(node instanceof proxy.LowLevelCompositeNode)){
            return;
        }
        var unit = node.unit();
        var extendedUnitMap = resolver.expandedPathMap(unit);
        if(extendedUnitMap==null){
            return;
        }
        var unitMap = resolver.pathMap(unit);
        if(!unitMap){
            unitMap = {};
        }

        var cNode = <proxy.LowLevelCompositeNode>node;
        var originalChildren = node.children();
        var usesNodes = originalChildren.filter(x=>
        x.key()==universeDef.Universe10.FragmentDeclaration.properties.uses.name);

        var oNode = toOriginal(node);
        var yamlNode = oNode;
        while(yamlNode instanceof proxy.LowLevelProxyNode){
            yamlNode = (<proxy.LowLevelProxyNode>yamlNode).originalNode();
        }

        var usesInfos = Object.keys(unitMap).map(x=>extendedUnitMap[x]);
        var extendedUsesInfos = Object.keys(extendedUnitMap).map(x=>extendedUnitMap[x])
            .filter(x=>!unitMap[x.absolutePath()]/*&&this.usedNamespaces[x.namespace()]*/);

        var u = node.unit();
        var unitPath = u.absolutePath();


        var existingLibs = {};
        var usesNode:proxy.LowLevelCompositeNode;
        if(usesNodes.length>0){
            usesNode = <proxy.LowLevelCompositeNode>usesNodes[0];
            usesNode.children().forEach(x=>existingLibs[x.key()]=true);
        }
        else{
            var newUses = jsyaml.createMapNode("uses");
            newUses["_parent"] = <jsyaml.ASTNode>yamlNode;
            newUses.setUnit(yamlNode.unit());
            usesNode = cNode.replaceChild(null,newUses);
        }        
        for (var ui of usesInfos.concat(extendedUsesInfos)) {
            var up = ui.absolutePath();
            if(existingLibs[ui.namespace()]){
                continue;
            }
            var ip = ui.includePath;
            var mapping = jsyaml.createMapping(ui.namespace(), ip);
            mapping.setUnit(yamlNode.unit());
            usesNode.replaceChild(null,mapping);
        }
    }

    removeUses(node:ll.ILowLevelASTNode){
        if(!(node instanceof proxy.LowLevelCompositeNode)){
            return;
        }
        var cNode = <proxy.LowLevelCompositeNode>node;
        var originalChildren = node.children();
        var usesNodes = originalChildren.filter(x=>
            x.key()==universeDef.Universe10.FragmentDeclaration.properties.uses.name);
        if(usesNodes.length>0){
            cNode.removeChild(usesNodes[0]);
        }
    }

    resetTypes(hlNode:hl.IHighLevelNode) {
        for(var ch of hlNode.elements()){
            this.resetTypes(ch);
        }
        delete hlNode.lowLevel().actual().types;
        delete hlNode["_ptype"];
        delete hlNode["_types"];
        (<hlimpl.ASTNodeImpl>hlNode).setAssociatedType(null);
    };

    appendUnitIfNeeded(node:hl.IParseResult|ll.ICompilationUnit,units:ll.ICompilationUnit[]):boolean{
        if(node instanceof jsyaml.CompilationUnit){
            var unit = <ll.ICompilationUnit>node;
            if (unit.absolutePath() != units[units.length - 1].absolutePath()) {
                units.push(unit);
                return true;
            }
            return false;
        }
        var originalNode = toOriginal((<hl.IParseResult>node).lowLevel());
        var originalUnit = originalNode.unit();
        if(originalNode.valueKind()==yaml.Kind.INCLUDE_REF){
            var ref = originalNode.includePath();
            var includedUnit = originalUnit.resolve(ref);
            units.push(includedUnit);
            return true;
        }
        else {
            if (originalUnit.absolutePath() != units[units.length - 1].absolutePath()) {
                units.push(originalUnit);
                return true;
            }
            return false;
        }
    }
    popUnitIfNeeded(units:ll.ICompilationUnit[],appended:boolean) {
        if (appended) {
            units.pop();
        }
    }

    registerPatchedReference(ref:PatchedReference){

        var collectionName = ref.collectionName();
        if(!collectionName){
            return;
        }

        var aPath = ref.referencedUnit().absolutePath();
        var libMap = this._outerDependencies[aPath];
        if(libMap==null){
            libMap = {};
            this._outerDependencies[aPath] = libMap;
        }
        var collectionMap = libMap[collectionName];
        if(collectionMap == null){
            collectionMap = {};
            libMap[collectionName] = collectionMap;
        }
        collectionMap[ref.name()] = ref;
    }

    private collectionName(range:def.ITypeDefinition):string {
        var collectionName:string;
        if (universeHelpers.isResourceTypeRefType(range)||universeHelpers.isResourceTypeType(range)) {
            collectionName = def.universesInfo.Universe10.LibraryBase.properties.resourceTypes.name;
        }
        else if (universeHelpers.isTraitRefType(range)||universeHelpers.isTraitType(range)) {
            collectionName = def.universesInfo.Universe10.LibraryBase.properties.traits.name;
        }
        else if (universeHelpers.isSecuritySchemeRefType(range)||universeHelpers.isSecuritySchemaTypeDescendant(range)) {
            collectionName = def.universesInfo.Universe10.LibraryBase.properties.securitySchemes.name;
        }
        else if (universeHelpers.isAnnotationRefTypeOrDescendant(range)||range.isAnnotationType()) {
            collectionName = def.universesInfo.Universe10.LibraryBase.properties.annotationTypes.name;
        }
        else if (universeHelpers.isTypeDeclarationDescendant(range)) {
            collectionName = def.universesInfo.Universe10.LibraryBase.properties.types.name;
        }
        return collectionName;
    }

    expandLibraries(api:hl.IHighLevelNode){

        if(api.lowLevel().actual().libExpanded){
            return;
        }
        var llNode = api.lowLevel();
        var unit = llNode.unit();
        var rootPath = unit.absolutePath();
        var project = unit.project();
        var usedNamespaces = Object.keys(this._outerDependencies).filter(x=>x!=rootPath);
        var libModels:LibModel[] = [];
        for(var ns of usedNamespaces){
            var libUnit = project.unit(ns,true);
            if(libUnit){
                var dependencies = this._outerDependencies[ns];
                var libModel = this.extractLibModel(libUnit,dependencies);
                libModels.push(libModel);
            }
        }
        var gotContribution = false;
        for(var libModel of libModels){
            for(var cName of Object.keys(libModel)){
                var collection = libModel[cName];
                if(collection instanceof ElementsCollection) {
                    gotContribution = gotContribution || this.contributeCollection(
                        <proxy.LowLevelCompositeNode>api.lowLevel(), <ElementsCollection>collection);
                }
            }
        }
        this.resetTypes(api);
        api.resetChildren();
        var apiPath = api.lowLevel().unit().absolutePath();
        for(var ch of api.children()){
            if(!ch.isElement()){
                continue;
            }
            var chPath = ch.lowLevel().unit().absolutePath();
            if(chPath==apiPath&&ch.lowLevel().includePath()==null){
                continue;
            }
            var definition = ch.asElement().definition();
            if(this.collectionName(definition)!=null){                
                this.process(ch.asElement(),api,true,true);
            }
        }
        if(gotContribution){
            this.expandLibraries(api);
        }
        this.removeUses(api.lowLevel());
        api.lowLevel().actual().libExpanded = true;
        this.resetTypes(api);
        api.resetChildren();
    }

    private contributeCollection(
        llApi:proxy.LowLevelCompositeNode, collection:ElementsCollection):boolean {

        var name = collection.name;
        var llNode:proxy.LowLevelCompositeNode = <proxy.LowLevelCompositeNode>_.find(
            llApi.children(),
            x=>x.key()==name);
        if(llNode==null){
            var n = jsyaml.createMapNode(name);
            llNode = llApi.replaceChild(null,n);
        }
        var result = false;
        for(var e of collection.array){
            if(llNode.children().some(x=>{
                    var oNode = toOriginal(x);
                    if(oNode.unit().absolutePath()!=e.lowLevel().unit().absolutePath()){
                        return false;
                    }
                    return e.lowLevel().key()==oNode.key();
                })){
                continue;
            }
            llNode.replaceChild(null,e.lowLevel());
            result = true;
        }
        return result;
    }



    private extractLibModel(unit:ll.ICompilationUnit,dependencies:DependencyMap):LibModel{
        var result:LibModel = new LibModel();
        var hlNode = (<jsyaml.CompilationUnit>unit).highLevel();
        if(hlNode && hlNode.isElement()){
            for(var cName of Object.keys(dependencies)){
                var dep = dependencies[cName];
                var collection = new ElementsCollection(cName);
                for(var el of hlNode.asElement().elementsOfKind(cName)){
                    if(dep[el.name()]){
                        collection.array.push(el);
                    }
                }
                result[cName] = collection;
            }
        }
        return result;
    }
}

enum ParametersEscapingStatus{
    OK, NOT_REQUIRED, ERROR
}

interface EscapeData{
    resultingString?: string,
    substitutions?: {[key:string]:string},
    status: ParametersEscapingStatus
}

var PARAM_OCCURENCE_STR = "__P_A_R_A_M_E_T_E_R__";

function escapeTemplateParameters(str:string):EscapeData{
    if(str==null||typeof str != "string"){
        return { status: ParametersEscapingStatus.NOT_REQUIRED }
    }
    var resultingString = "";
    var map:{[key:string]:string} = {};
    var prev = 0;
    for(var i = str.indexOf("<<") ; i>=0 ; i = str.indexOf("<<",prev)){
        resultingString += str.substring(prev,i);
        prev = str.indexOf(">>",i);
        if(prev<0){
            return { status: ParametersEscapingStatus.ERROR };
        }
        prev += ">>".length;
        var paramStr = str.substring(i,prev);
        var substitution = PARAM_OCCURENCE_STR + i + PARAM_OCCURENCE_STR;
        map[substitution] = paramStr;
        resultingString+=substitution;
    }
    if(resultingString.length==0){
        return { status: ParametersEscapingStatus.NOT_REQUIRED }
    }
    resultingString += str.substring(prev,str.length);
    return {
        resultingString: resultingString,
        substitutions: map,
        status: ParametersEscapingStatus.OK
    };
}

function unescapeTemplateParameters(str:string,substitutions:{[key:string]:string}):EscapeData{
    if(str==null){
        return { status: ParametersEscapingStatus.NOT_REQUIRED };
    }
    var resultingString = "";
    var prev = 0;
    for(var i = str.indexOf(PARAM_OCCURENCE_STR); i>=0 ; i = str.indexOf(PARAM_OCCURENCE_STR,prev)){
        prev = str.indexOf(PARAM_OCCURENCE_STR,i+1);
        prev += PARAM_OCCURENCE_STR.length;
        if(prev<0){
            return { status: ParametersEscapingStatus.ERROR };
        }
        var substitution = str.substring(i,prev);
        var originalParamOccurence = substitutions[substitution];
        if(originalParamOccurence==null){
            return { status: ParametersEscapingStatus.ERROR };
        }
        resultingString += originalParamOccurence;
    }
    if(resultingString.length==0){
        return { status: ParametersEscapingStatus.NOT_REQUIRED };
    }
    resultingString += str.substring(prev,str.length);
    return {
        resultingString: resultingString,
        substitutions: substitutions,
        status: ParametersEscapingStatus.OK
    };
}


function checkExpression(value:string) {
    var gotExpression = false;
    for (let i = 0; i < value.length; i++) {
        let ch = value.charAt(i);
        if (ch == "|" || ch == "(" || ch == "[") {
            gotExpression = true;
            break;
        }
    }
    return gotExpression;
};


export function patchMethodIs(node:hl.IHighLevelNode,traits:{
    node:ll.ILowLevelASTNode,
    transformer:proxy.ValueTransformer
}[]):proxy.LowLevelCompositeNode{
    
    var llMethod = <proxy.LowLevelCompositeNode>node.lowLevel();
    var ramlVersion = node.definition().universe().version();
    var originalLlMethod = toOriginal(llMethod);
    var isPropertyName = universeDef.Universe10.MethodBase.properties.is.name;
    var isNode = <proxy.LowLevelCompositeNode>_.find(
        llMethod.children(), x=>x.key() == isPropertyName);

    if(isNode==null){
        var newLLIsNode = new jsyaml.ASTNode(
            yaml.newMapping(yaml.newScalar(isPropertyName), yaml.newItems())
            ,originalLlMethod.unit(),<jsyaml.ASTNode>originalLlMethod,null,null);

        isNode = (<proxy.LowLevelCompositeNode>llMethod).replaceChild(null,newLLIsNode);
    }
    var originalIsNode = _.find(originalLlMethod.children(), x=>x.key()==isPropertyName);
    var childrenToPreserve = originalIsNode != null ? originalIsNode.children() : [];

    var newTraits = childrenToPreserve.concat(traits.map(x=>{
        var llChNode = prepareTraitRefNode(x.node,isNode);
        if(llChNode!=null) {
            var cNode = new proxy.LowLevelCompositeNode(llChNode, isNode, x.transformer, ramlVersion);
            return cNode;
        }
        return null;
    })).filter(x=>x!=null);
    isNode.setChildren(newTraits);
    isNode.filterChildren();
    return isNode;
}

export function prepareTraitRefNode(llNode:ll.ILowLevelASTNode,llParent:ll.ILowLevelASTNode){

    llParent = toOriginal(llParent);
    llNode = toOriginal(llNode);
    var yNode = <yaml.YAMLNode>llNode.actual();
    if(yNode==null){
        return null;
    }
    if(llNode.key()==universeDef.Universe10.MethodBase.properties.is.name){
        yNode = (<jsyaml.ASTNode>llNode).yamlNode().value;
    }
    if(yNode==null){
        return null;
    }
    if(yNode.kind == yaml.Kind.SEQ){
        yNode = (<yaml.YAMLSequence>yNode).items[0];
    }
    if(yNode==null){
        return null;
    }
    var result = new jsyaml.ASTNode(yNode,llNode.unit(),<jsyaml.ASTNode>llParent,null,null);
    return result;
}

function toOriginal(node:ll.ILowLevelASTNode){
    for(var i = 0; i<2 && node instanceof proxy.LowLevelProxyNode; i++){
        node = (<proxy.LowLevelProxyNode>node).originalNode();
    }
    return node;
}

export class PatchedReference{

    constructor(
        private _namespace:string,
        private _name:string,
        private _collectionName:string,
        private _referencedUnit:ll.ICompilationUnit,
        private _mode:PatchMode){}

    namespace():string{ return this._namespace; }

    name():string{ return this._name; }

    collectionName():string{ return this._collectionName; }

    referencedUnit():ll.ICompilationUnit{ return this._referencedUnit; }
    
    mode():PatchMode{ return this._mode; }

    value():string{
        if(this._namespace==null){
            return this._name;
        }
        var delim = this._mode == PatchMode.PATH ? "/" : ".";
        return this._namespace + delim + this._name;
    }
}

class ElementsCollection{
    constructor(public name:string){}

    array:hl.IHighLevelNode[] = [];
}

class LibModel{

    resourceTypes:ElementsCollection;

    traits:ElementsCollection;

    securitySchemes:ElementsCollection;

    annotationTypes:ElementsCollection;

    types:ElementsCollection;

}

type DependencyMap = {[key:string]:{[key:string]:PatchedReference}};
